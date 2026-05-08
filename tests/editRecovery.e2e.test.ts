import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { TokiEngine } from "../src/core/engine.js";

const ENV_KEYS = ["TOKI_TEST_PROVIDER_SCRIPT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"] as const;
const ORIGINAL_ENV = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV.get(key);
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
});

describe("edit recovery end-to-end", () => {
  test("repairs a noisy pasted transcript and edits the intended file without reading .git", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "toki-e2e-edit-"));
    const repoDir = path.join(tmpRoot, "repo");
    const homeDir = path.join(tmpRoot, "home");
    await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.mkdir(path.join(homeDir, ".toki"), { recursive: true });

    await fs.writeFile(path.join(repoDir, "README.md"), "# Demo\n", "utf8");
    await fs.writeFile(path.join(repoDir, "package.json"), JSON.stringify({ name: "demo", type: "module" }, null, 2), "utf8");
    await fs.writeFile(path.join(repoDir, "src", "app.ts"), "export const answer = 1;\n", "utf8");

    await fs.writeFile(
      path.join(homeDir, ".toki", "config.toml"),
      [
        'default_provider = "scripted"',
        'default_model = "scripted-model"',
        "",
        "[runtime]",
        "model_round_timeout_ms = 2000",
        "model_round_retries = 0",
        "model_round_retry_backoff_ms = 1",
        "max_tool_rounds = 4",
        "edit_tool_call_retries = 0"
      ].join("\n"),
      "utf8"
    );

    await fs.writeFile(
      path.join(tmpRoot, "scripted-provider.json"),
      JSON.stringify(
        {
          models: [{ id: "scripted-model", label: "scripted-model" }],
          streamResponses: ["", ""],
          chatRules: [
            {
              whenSystemIncludes: "repairing a failed coding-agent edit loop",
              whenLastUserIncludes: "READ(.git)",
              response: '[{"tool":"read","path":".git","offset":1,"limit":20}]'
            },
            {
              whenSystemIncludes: "repairing a failed coding-agent edit loop",
              whenLastUserIncludes: "read src/app.ts",
              response:
                '[{"tool":"edit","path":"src/app.ts","edits":[{"oldText":"export const answer = 1;","newText":"export const answer = 2;"}]}]'
            },
            {
              whenSystemIncludes: "repairing a failed coding-agent edit loop",
              response: '[{"tool":"read","path":"src/app.ts","offset":1,"limit":20}]'
            },
            {
              whenSystemIncludes: "Provide the final user-facing answer",
              response: "Updated src/app.ts to use answer = 2."
            }
          ],
          defaultChatResponse: "[]"
        },
        null,
        2
      ),
      "utf8"
    );

    process.env.TOKI_TEST_PROVIDER_SCRIPT = path.join(tmpRoot, "scripted-provider.json");
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;

    const engine = new TokiEngine();
    await engine.initialize({ cwd: repoDir });

    const chunks: string[] = [];
    const result = await engine.runTurn(
      [
        "TOOLING(.)",
        "  L INFO Generated recovery tool calls from failed edit transcript",
        "READ(README.md)",
        "READ(package.json)",
        "READ(.git)",
        "",
        "look at this it fails here i mean for some reason i cant get my agent to edit any files like it always breaks",
        "Fix src/app.ts by changing answer to 2."
      ].join("\n"),
      (chunk) => chunks.push(chunk)
    );

    const updated = await fs.readFile(path.join(repoDir, "src", "app.ts"), "utf8");
    expect(updated).toContain("export const answer = 2;");
    expect(result.response).toContain("Updated src/app.ts");
    expect(chunks.join("")).not.toContain("READ(.git)");
    expect(chunks.join("")).not.toContain("EISDIR");

    await fs.rm(tmpRoot, { recursive: true, force: true });
  });
});
