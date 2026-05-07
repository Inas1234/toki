import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { describe, expect, test } from "vitest";
import { ContextGraph } from "../src/core/graph/contextGraph.js";
import { ContextBroker, isBlocked } from "../src/core/broker/contextBroker.js";
import { buildTaskFrame } from "../src/core/task/taskFrame.js";
import { GlobalConfig, RepoConfig } from "../src/core/types.js";

describe("ContextBroker", () => {
  test("blocks hard-blocklist files before scoring", () => {
    expect(isBlocked("package-lock.json")).toBe(true);
    expect(isBlocked(".toki/index/repo-map.json")).toBe(true);
    expect(isBlocked("src/bundle.min.js")).toBe(true);
    expect(isBlocked("src/main.ts")).toBe(false);
  });

  test("selects highest-value files under budget", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-broker-"));
    await fs.mkdir(path.join(tmp, "src"), { recursive: true });
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.writeFile(path.join(tmp, "src", "auth.ts"), "export class AuthService { login(){ return true; } }", "utf8");
    await fs.writeFile(path.join(tmp, "src", "util.ts"), "export const add=(a:number,b:number)=>a+b;", "utf8");

    const repoConfig: RepoConfig = {
      repoType: "generic",
      testCommand: "npm test",
      generatedPaths: ["node_modules", "dist", ".git", ".toki/index"],
      importantPaths: []
    };
    const globalConfig: GlobalConfig = {
      defaultModel: "llama-3.1-nemotron-ultra",
      defaultProvider: "nim",
      mode: "normal",
      showReceipts: true,
      providerApiKeys: {},
      budget: {
        tinyCeiling: 100,
        normalCeiling: 500,
        deepCeiling: 1000
      },
      runtime: {
        modelRoundTimeoutMs: 45000,
        modelRoundRetries: 2,
        modelRoundRetryBackoffMs: 1000,
        maxToolRounds: 6,
        editToolCallRetries: 2
      }
    };

    const graph = new ContextGraph(tmp, repoConfig, path.join(tmp, ".toki", "index"));
    await graph.initialize();
    await graph.waitForIndexing();
    const broker = new ContextBroker("auto");
    const frame = buildTaskFrame("Fix AuthService login");
    const result = await broker.selectContext(1, frame, graph, globalConfig);

    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.some((item) => item.path?.includes("auth.ts"))).toBe(true);
    expect(result.receipt.usedTokens).toBeLessThanOrEqual(result.receipt.ceiling);

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("records blocked and low-relevance skipped files in receipt", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-broker-skip-"));
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.mkdir(path.join(tmp, "packages", "tui"), { recursive: true });
    await fs.writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "demo", dependencies: { react: "^19.0.0" } }), "utf8");
    await fs.writeFile(path.join(tmp, "README.md"), "Uses React for UI", "utf8");
    await fs.writeFile(path.join(tmp, "packages", "tui", "package.json"), JSON.stringify({ name: "@demo/tui" }), "utf8");
    await fs.writeFile(path.join(tmp, "package-lock.json"), "{}", "utf8");
    await fs.writeFile(path.join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022" } }), "utf8");

    const repoConfig: RepoConfig = {
      repoType: "generic",
      testCommand: "npm test",
      generatedPaths: ["node_modules", "dist", ".git", ".toki/index"],
      importantPaths: []
    };
    const globalConfig: GlobalConfig = {
      defaultModel: "llama-3.1-nemotron-ultra",
      defaultProvider: "nim",
      mode: "normal",
      showReceipts: true,
      providerApiKeys: {},
      budget: {
        tinyCeiling: 4000,
        normalCeiling: 12000,
        deepCeiling: 24000
      },
      runtime: {
        modelRoundTimeoutMs: 45000,
        modelRoundRetries: 2,
        modelRoundRetryBackoffMs: 1000,
        maxToolRounds: 6,
        editToolCallRetries: 2
      }
    };

    const graph = new ContextGraph(tmp, repoConfig, path.join(tmp, ".toki", "index"));
    await graph.initialize();
    await graph.waitForIndexing();
    const broker = new ContextBroker("normal");
    const frame = buildTaskFrame("what UI framework is used");
    const result = await broker.selectContext(1, frame, graph, globalConfig);

    expect(result.receipt.loaded.map((item) => item.path)).toEqual(
      expect.arrayContaining(["package.json", "README.md", "packages/tui/package.json"])
    );
    expect(result.receipt.skipped.some((item) => item.path === "package-lock.json" && item.reason.includes("hard blocklist"))).toBe(true);
    expect(result.receipt.skipped.some((item) => item.reason.startsWith("low relevance: score"))).toBe(true);

    await fs.rm(tmp, { recursive: true, force: true });
  });
});
