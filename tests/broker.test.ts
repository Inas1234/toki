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

  test("materializes code content for explicit edit targets instead of symbol-only summaries", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-broker-edit-"));
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.mkdir(path.join(tmp, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, "src", "auth.ts"),
      "export class AuthService {\n  login() {\n    return true;\n  }\n}\n",
      "utf8"
    );

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
    const frame = buildTaskFrame("Fix src/auth.ts so AuthService login returns false");
    const result = await broker.selectContext(1, frame, graph, globalConfig);
    const authItem = result.items.find((item) => item.path === "src/auth.ts");

    expect(authItem).toBeDefined();
    expect(authItem?.representation).not.toBe("symbols");
    expect(authItem?.content).toContain("AuthService");
    expect(authItem?.content).toContain("login");

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("prefers agent internals over pasted transcript targets for debugging requests", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-broker-agent-"));
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.mkdir(path.join(tmp, "src", "core"), { recursive: true });
    await fs.mkdir(path.join(tmp, "src", "cli"), { recursive: true });
    await fs.mkdir(path.join(tmp, "packages", "tui", "src"), { recursive: true });
    await fs.writeFile(path.join(tmp, "src", "core", "engine.ts"), "export class TokiEngine { runTurn() {} }\n", "utf8");
    await fs.writeFile(path.join(tmp, "src", "core", "toolCalls.ts"), "export function parseToolCallsFromText() {}\n", "utf8");
    await fs.writeFile(path.join(tmp, "src", "core", "broker.ts"), "export class ContextBroker {}\n", "utf8");
    await fs.writeFile(path.join(tmp, "src", "cli", "App.tsx"), "export function App() { return null; }\n", "utf8");
    await fs.writeFile(path.join(tmp, "packages", "tui", "src", "index.tsx"), "export const SlashAutocomplete = () => null;\n", "utf8");

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
    const frame = buildTaskFrame(
      [
        'SEARCH(packages/tui/src, "tab completion cursor")',
        "READ(src/cli/App.tsx)",
        "",
        "Check exactly what is causing my agent to fail to search the codebase and fix it.",
        "Ignore the cursor stuff. That is just an example."
      ].join("\n")
    );
    const result = await broker.selectContext(1, frame, graph, globalConfig);
    const loadedPaths = result.items.map((item) => item.path);

    expect(loadedPaths).toContain("src/core/engine.ts");
    expect(loadedPaths.some((value) => value?.startsWith("src/core/") && value !== "src/core/engine.ts")).toBe(true);
    expect(loadedPaths).not.toContain("src/cli/App.tsx");

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("does not let transcript diff noise pull README into agent-debug context", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-broker-transcript-"));
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.mkdir(path.join(tmp, "packages", "coding-agent", "src"), { recursive: true });
    await fs.writeFile(path.join(tmp, "README.md"), "# Demo\n", "utf8");
    await fs.writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "demo", type: "module" }), "utf8");
    await fs.writeFile(
      path.join(tmp, "packages", "coding-agent", "src", "engine.ts"),
      "export class TokiEngine { runTurn() {} }\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "packages", "coding-agent", "src", "taskFrame.ts"),
      "export function buildTaskFrame(raw: string) { return raw; }\n",
      "utf8"
    );

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
    const frame = buildTaskFrame(
      [
        "READ(README.md)",
        "READ(package.json)",
        "EDIT(README.md)",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -1,3 +1,3 @@",
        "- old docs",
        "+ new docs",
        "",
        "Why is this happening i mean why cant it understand the actual context or whatever how does this work in other AI coding agents and why is mine so stupid i dont get it the model i am using isnt bad like it is not the models fault it is the agent fault",
        "",
        "implement it"
      ].join("\n")
    );
    const result = await broker.selectContext(1, frame, graph, globalConfig);
    const loadedPaths = result.items.map((item) => item.path);

    expect(loadedPaths).toContain("packages/coding-agent/src/engine.ts");
    expect(loadedPaths.some((value) => value?.startsWith("packages/coding-agent/src/"))).toBe(true);
    expect(loadedPaths).not.toContain("README.md");

    await fs.rm(tmp, { recursive: true, force: true });
  });
});
