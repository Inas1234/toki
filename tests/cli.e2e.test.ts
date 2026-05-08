import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";

const ENV_KEYS = ["TOKI_TEST_PROVIDER_SCRIPT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"] as const;
const ORIGINAL_ENV = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
}

async function createCliFixture() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "toki-cli-e2e-"));
  const repoDir = path.join(tmpRoot, "repo");
  const homeDir = path.join(tmpRoot, "home");
  await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
  await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
  await fs.mkdir(path.join(homeDir, ".toki"), { recursive: true });
  await fs.writeFile(path.join(repoDir, "src", "app.ts"), "export const answer = 1;\n", "utf8");
  await fs.writeFile(path.join(repoDir, "README.md"), "# Demo\n", "utf8");
  await fs.writeFile(path.join(repoDir, "package.json"), JSON.stringify({ name: "demo", type: "module" }, null, 2), "utf8");
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

  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;

  return { tmpRoot, repoDir };
}

async function runCli(args: string[], repoDir: string, stdinText = "") {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const rootDir = process.cwd();
    const child = spawn(
      process.execPath,
      [path.join(rootDir, "node_modules", "tsx", "dist", "cli.mjs"), path.join(rootDir, "src", "index.ts"), ...args],
      {
        cwd: repoDir,
        env: { ...process.env, FORCE_COLOR: "0" },
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) }));

    if (stdinText.length > 0) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
}

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

describe("CLI end-to-end", () => {
  test("accepts a direct prompt argument in non-interactive mode and edits the target file", async () => {
    const { tmpRoot, repoDir } = await createCliFixture();
    const fixturePath = path.join(tmpRoot, "scripted-provider.json");
    await fs.writeFile(
      fixturePath,
      JSON.stringify(
        {
          models: [{ id: "scripted-model", label: "scripted-model" }],
          streamResponses: [
            '<tool_calls>[{"tool":"read","path":"src/app.ts","offset":1,"limit":20}]</tool_calls>',
            '<tool_calls>[{"tool":"edit","path":"src/app.ts","edits":[{"oldText":"export const answer = 1;","newText":"export const answer = 2;"}]}]</tool_calls>'
          ],
          chatRules: [
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
    process.env.TOKI_TEST_PROVIDER_SCRIPT = fixturePath;

    const result = await runCli(["Fix src/app.ts by changing answer to 2"], repoDir);
    const updated = await fs.readFile(path.join(repoDir, "src", "app.ts"), "utf8");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Updated src/app.ts to use answer = 2.");
    expect(result.stdout).not.toContain("Raw mode is not supported");
    expect(updated).toContain("export const answer = 2;");

    await fs.rm(tmpRoot, { recursive: true, force: true });
  }, 15000);

  test("accepts a piped stdin prompt and recovers from noisy transcript input without reading .git", async () => {
    const { tmpRoot, repoDir } = await createCliFixture();
    const fixturePath = path.join(tmpRoot, "scripted-provider.json");
    await fs.writeFile(
      fixturePath,
      JSON.stringify(
        {
          models: [{ id: "scripted-model", label: "scripted-model" }],
          streamResponses: [""],
          chatRules: [
            {
              whenSystemIncludes: "repairing a failed coding-agent edit loop",
              response: '[{"tool":"read","path":"src/app.ts","offset":1,"limit":20}]'
            },
            {
              whenSystemIncludes: "repairing a stalled coding-agent edit turn",
              whenLastUserIncludes: "read src/app.ts",
              response:
                '[{"tool":"edit","path":"src/app.ts","edits":[{"oldText":"export const answer = 1;","newText":"export const answer = 2;"}]}]'
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
    process.env.TOKI_TEST_PROVIDER_SCRIPT = fixturePath;

    const prompt = [
      "TOOLING(.)",
      "  L INFO Generated recovery tool calls from failed edit transcript",
      "READ(README.md)",
      "READ(package.json)",
      "READ(.git)",
      "",
      "look at this it fails here i mean for some reason i cant get my agent to edit any files like it always breaks",
      "Fix src/app.ts by changing answer to 2."
    ].join("\n");

    const result = await runCli([], repoDir, `${prompt}\n`);
    const updated = await fs.readFile(path.join(repoDir, "src", "app.ts"), "utf8");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Updated src/app.ts to use answer = 2.");
    expect(result.stdout).not.toContain("Raw mode is not supported");
    expect(result.stdout).not.toContain("READ(.git)");
    expect(result.stdout).not.toContain("EISDIR");
    expect(updated).toContain("export const answer = 2;");

    await fs.rm(tmpRoot, { recursive: true, force: true });
  }, 15000);
});
