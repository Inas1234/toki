import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promises as fs } from "node:fs";
import { execSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { TokiEngine } from "../src/core/engine.js";
import { ContextItem, ContextReceipt, GlobalConfig, ProviderChatMessage, RepoConfig } from "../src/core/types.js";
import { ModelProvider } from "../src/providers/base.js";

class ScriptedProvider implements ModelProvider {
  public readonly id = "scripted";
  public readonly name = "Scripted";
  private readonly streamResponses: string[];
  private readonly chatHandler: (messages: ProviderChatMessage[]) => string;

  public constructor(streamResponses: string[], chatHandler: (messages: ProviderChatMessage[]) => string) {
    this.streamResponses = [...streamResponses];
    this.chatHandler = chatHandler;
  }

  public async listModels() {
    return [{ id: "scripted-model", label: "scripted-model" }];
  }

  public async chat(messages: ProviderChatMessage[]) {
    return {
      text: this.chatHandler(messages),
      model: "scripted-model"
    };
  }

  public async *streamChat(): AsyncGenerator<{ text: string; done: boolean; channel?: "content" | "reasoning" }> {
    const next = this.streamResponses.shift() ?? "";
    if (next.length > 0) {
      yield { text: next, done: false, channel: "content" };
    }
    yield { text: "", done: true, channel: "content" };
  }

  public estimateTokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / 4));
  }
}

function createReceipt(): ContextReceipt {
  return {
    turn: 1,
    mode: "normal",
    ceiling: 4000,
    usedTokens: 120,
    savedTokens: 0,
    loaded: [],
    skipped: [],
    compressed: []
  };
}

function createConfig(tmp: string): { global: GlobalConfig; repo: RepoConfig; paths: any } {
  return {
    global: {
      defaultModel: "scripted-model",
      defaultProvider: "scripted",
      mode: "normal",
      showReceipts: true,
      providerApiKeys: {},
      budget: {
        tinyCeiling: 1000,
        normalCeiling: 4000,
        deepCeiling: 8000
      },
      runtime: {
        modelRoundTimeoutMs: 2000,
        modelRoundRetries: 0,
        modelRoundRetryBackoffMs: 1,
        maxToolRounds: 1,
        editToolCallRetries: 0
      }
    },
    repo: {
      repoType: "generic",
      testCommand: "npm test",
      generatedPaths: ["node_modules", "dist", ".git", ".toki/index"],
      importantPaths: []
    },
    paths: {
      repoConfigPath: path.join(tmp, ".toki", "config.toml"),
      globalConfigPath: path.join(tmp, ".toki", "global.toml"),
      repoRulesPath: path.join(tmp, ".toki", "rules.md"),
      repoIndexDir: path.join(tmp, ".toki", "index"),
      globalDir: path.join(tmp, ".toki"),
      repoDir: tmp
    }
  };
}

function createSelection(targetPath: string): { items: ContextItem[]; receipt: ContextReceipt } {
  return {
    items: [
      {
        id: `${targetPath}:snippet`,
        type: "file",
        path: targetPath,
        representation: "targeted_snippet",
        content: "const answer = 1;",
        estimatedTokens: 8,
        relevanceScore: 100,
        freshness: 1,
        source: targetPath,
        reason: "test fixture",
        priority: 100
      }
    ],
    receipt: createReceipt()
  };
}

function createSelectionForPaths(paths: string[]): { items: ContextItem[]; receipt: ContextReceipt } {
  return {
    items: paths.map((targetPath) => ({
      id: `${targetPath}:snippet`,
      type: "file",
      path: targetPath,
      representation: "targeted_snippet",
      content: `snippet for ${targetPath}`,
      estimatedTokens: 8,
      relevanceScore: 100,
      freshness: 1,
      source: targetPath,
      reason: "test fixture",
      priority: 100
    })),
    receipt: createReceipt()
  };
}

function createEngineHarness(
  tmp: string,
  provider: ModelProvider,
  selection: { items: ContextItem[]; receipt: ContextReceipt }
): TokiEngine {
  const engine = new TokiEngine() as TokiEngine & Record<string, any>;
  const config = createConfig(tmp);
  engine.config = config;
  engine.providerId = "scripted";
  engine.modelId = "scripted-model";
  engine.graph = {};
  engine.providers = {
    get: () => provider
  };
  engine.broker = {
    getMode: () => "normal",
    getPinned: () => [],
    selectContext: async () => selection
  };
  return engine;
}

describe("TokiEngine edit recovery", () => {
  test("search_files falls back to keyword matching when an exact phrase is absent", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-engine-search-"));
    await fs.mkdir(path.join(tmp, "src", "cli"), { recursive: true });
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, "src", "cli", "App.tsx"),
      ["const cursorPosition = 0;", "useInput((input) => input);", ""].join("\n"),
      "utf8"
    );

    const provider = new ScriptedProvider(
      ['<tool_calls>[{"tool":"search_files","path":"src","query":"cursor position input","max_results":5}]</tool_calls>'],
      (messages) => {
        const system = messages[0]?.content ?? "";
        if (system.includes("Provide the final user-facing answer")) {
          return "Searched the repo and returned likely keyword matches.";
        }
        return "[]";
      }
    );

    const engine = createEngineHarness(tmp, provider, createSelectionForPaths([]));
    const chunks: string[] = [];
    const result = await engine.runTurn("Find the tab-completion code", (chunk) => chunks.push(chunk));

    expect(result.response).toContain("keyword matches");
    expect(chunks.join("")).toContain('FOUND 2 match(es) for "cursor position input"');
    expect(chunks.join("")).toContain("cli/App.tsx:1: const cursorPosition = 0;");
    expect(chunks.join("")).toContain("cli/App.tsx:2: useInput((input) => input);");

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("search_files supports a direct file path target", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-engine-search-file-"));
    await fs.mkdir(path.join(tmp, "src"), { recursive: true });
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.writeFile(path.join(tmp, "src", "app.ts"), "const answer = 1;\n", "utf8");

    const provider = new ScriptedProvider(
      ['<tool_calls>[{"tool":"search_files","path":"src/app.ts","query":"answer","max_results":5}]</tool_calls>'],
      (messages) => {
        const system = messages[0]?.content ?? "";
        if (system.includes("Provide the final user-facing answer")) {
          return "Searched the file directly and found the match.";
        }
        return "[]";
      }
    );

    const engine = createEngineHarness(tmp, provider, createSelectionForPaths([]));
    const chunks: string[] = [];
    const result = await engine.runTurn("Search the direct file path", (chunk) => chunks.push(chunk));

    expect(result.response).toContain("found the match");
    expect(chunks.join("")).toContain('FOUND 1 match(es) for "answer"');
    expect(chunks.join("")).toContain("src/app.ts:1: const answer = 1;");
    expect(chunks.join("")).not.toContain("ENOTDIR");

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("forces a mutation attempt after a read-only edit round", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-engine-"));
    const targetPath = "src/app.ts";
    await fs.mkdir(path.join(tmp, "src"), { recursive: true });
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.writeFile(path.join(tmp, targetPath), "const answer = 1;\n", "utf8");

    const provider = new ScriptedProvider(
      ['<tool_calls>[{"tool":"read","path":"src/app.ts","offset":1,"limit":20}]</tool_calls>'],
      (messages) => {
        const system = messages[0]?.content ?? "";
        if (system.includes("repairing a stalled coding-agent edit turn")) {
          return '[{"tool":"edit","path":"src/app.ts","edits":[{"oldText":"const answer = 1;","newText":"const answer = 2;"}]}]';
        }
        if (system.includes("Provide the final user-facing answer")) {
          return "Updated src/app.ts to use answer = 2.";
        }
        return "[]";
      }
    );

    const engine = createEngineHarness(tmp, provider, createSelection(targetPath));
    const chunks: string[] = [];
    const result = await engine.runTurn("Fix src/app.ts by changing answer to 2", (chunk) => chunks.push(chunk));

    const updated = await fs.readFile(path.join(tmp, targetPath), "utf8");
    expect(updated).toContain("const answer = 2;");
    expect(result.response).toContain("Updated src/app.ts");
    expect(chunks.join("")).toContain("* EDIT(src/app.ts)");

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("returns a useful failure summary when forced mutation recovery cannot edit", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-engine-fail-"));
    const targetPath = "src/app.ts";
    await fs.mkdir(path.join(tmp, "src"), { recursive: true });
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.writeFile(path.join(tmp, targetPath), "const answer = 1;\n", "utf8");

    const provider = new ScriptedProvider(
      ['<tool_calls>[{"tool":"read","path":"src/app.ts","offset":1,"limit":20}]</tool_calls>'],
      (messages) => {
        const system = messages[0]?.content ?? "";
        if (system.includes("repairing a stalled coding-agent edit turn")) {
          return "[]";
        }
        if (system.includes("Explain why the edit task failed")) {
          return "I inspected src/app.ts, but no valid edit tool call was produced, so no file was changed.";
        }
        return "[]";
      }
    );

    const engine = createEngineHarness(tmp, provider, createSelection(targetPath));
    const result = await engine.runTurn("Fix src/app.ts by changing answer to 2", () => {});

    expect(result.response).toContain("no valid edit tool call was produced");
    expect(result.response).not.toContain("Edit run finished with no successful file mutation after recovery retries");

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("prefers files discovered during the turn over stale broker selections", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-engine-discovered-"));
    await fs.mkdir(path.join(tmp, "src"), { recursive: true });
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.writeFile(path.join(tmp, "src", "app.ts"), "const answer = 1;\n", "utf8");
    await fs.writeFile(path.join(tmp, "src", "wrong.ts"), "const wrong = true;\n", "utf8");

    const provider = new ScriptedProvider(
      ['<tool_calls>[{"tool":"read","path":"src/app.ts","offset":1,"limit":20}]</tool_calls>'],
      (messages) => {
        const system = messages[0]?.content ?? "";
        const transcript = messages[messages.length - 1]?.content ?? "";
        if (system.includes("repairing a stalled coding-agent edit turn")) {
          if (transcript.includes("src/wrong.ts")) {
            return "[]";
          }
          if (transcript.includes("src/app.ts")) {
            return '[{"tool":"edit","path":"src/app.ts","edits":[{"oldText":"const answer = 1;","newText":"const answer = 2;"}]}]';
          }
        }
        if (system.includes("Provide the final user-facing answer")) {
          return "Updated src/app.ts to use answer = 2.";
        }
        return "[]";
      }
    );

    const engine = createEngineHarness(tmp, provider, createSelectionForPaths(["src/wrong.ts"]));
    const result = await engine.runTurn("Fix the file that contains answer = 1 so it becomes 2", () => {});

    const updated = await fs.readFile(path.join(tmp, "src", "app.ts"), "utf8");
    expect(updated).toContain("const answer = 2;");
    expect(result.response).toContain("Updated src/app.ts");

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("repairs prose mutation suggestions into executable edit calls", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-engine-prose-"));
    const targetPath = "src/app.ts";
    await fs.mkdir(path.join(tmp, "src"), { recursive: true });
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.writeFile(path.join(tmp, targetPath), "const answer = 1;\n", "utf8");

    const provider = new ScriptedProvider(
      ['<tool_calls>[{"tool":"read","path":"src/app.ts","offset":1,"limit":20}]</tool_calls>'],
      (messages) => {
        const system = messages[0]?.content ?? "";
        if (system.includes("repairing a stalled coding-agent edit turn")) {
          return [
            "The fix is to replace the constant value.",
            "replace_in_file src/app.ts:",
            "find: const answer = 1;",
            "replace: const answer = 2;"
          ].join("\n");
        }
        if (system.includes("Convert assistant text into executable tool calls")) {
          return '[{"tool":"replace_in_file","path":"src/app.ts","find":"const answer = 1;","replace":"const answer = 2;"}]';
        }
        if (system.includes("Provide the final user-facing answer")) {
          return "Updated src/app.ts to use answer = 2.";
        }
        return "[]";
      }
    );

    const engine = createEngineHarness(tmp, provider, createSelection(targetPath));
    const result = await engine.runTurn("Fix src/app.ts by changing answer to 2", () => {});

    const updated = await fs.readFile(path.join(tmp, targetPath), "utf8");
    expect(updated).toContain("const answer = 2;");
    expect(result.response).toContain("Updated src/app.ts");

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("rejects repaired non-mutation calls during forced mutation recovery", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-engine-search-leak-"));
    const targetPath = "src/app.ts";
    await fs.mkdir(path.join(tmp, "src"), { recursive: true });
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.writeFile(path.join(tmp, targetPath), "const answer = 1;\n", "utf8");

    const provider = new ScriptedProvider(
      ['<tool_calls>[{"tool":"read","path":"src/app.ts","offset":1,"limit":20}]</tool_calls>'],
      (messages) => {
        const system = messages[0]?.content ?? "";
        if (system.includes("repairing a stalled coding-agent edit turn")) {
          return [
            "The tab completion logic may be elsewhere.",
            "Search more broadly for autocomplete handlers.",
            "search_files packages query=\"autocomplete\""
          ].join("\n");
        }
        if (system.includes("Convert assistant text into executable tool calls")) {
          return '[{"tool":"search_files","path":"packages","query":"autocomplete"}]';
        }
        if (system.includes("Explain why the edit task failed")) {
          return "I inspected src/app.ts, but forced mutation recovery only produced more search suggestions, so no file was changed.";
        }
        return "[]";
      }
    );

    const engine = createEngineHarness(tmp, provider, createSelection(targetPath));
    const chunks: string[] = [];
    const result = await engine.runTurn("Fix src/app.ts by changing answer to 2", (chunk) => chunks.push(chunk));

    const updated = await fs.readFile(path.join(tmp, targetPath), "utf8");
    expect(updated).toContain("const answer = 1;");
    expect(result.response).toContain("no file was changed");
    expect(chunks.join("")).not.toContain("SEARCH(");
    expect(chunks.join("")).not.toContain("Forced mutation recovery generated edit/write tool calls");

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("rejects shell exploration commands during edit recovery", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-engine-run-leak-"));
    const targetPath = "src/app.ts";
    await fs.mkdir(path.join(tmp, "src"), { recursive: true });
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.writeFile(path.join(tmp, targetPath), "const answer = 1;\n", "utf8");

    const provider = new ScriptedProvider(
      [""],
      (messages) => {
        const system = messages[0]?.content ?? "";
        if (system.includes("repairing a failed coding-agent edit loop")) {
          return '[{"tool":"run_command","command":"cat .git/HEAD"}]';
        }
        if (system.includes("repairing a stalled coding-agent edit turn")) {
          return "[]";
        }
        if (system.includes("Explain why the edit task failed")) {
          return "I inspected src/app.ts, but edit recovery only proposed shell exploration, so no file was changed.";
        }
        return "[]";
      }
    );

    const engine = createEngineHarness(tmp, provider, createSelection(targetPath));
    const chunks: string[] = [];
    const result = await engine.runTurn("Fix src/app.ts by changing answer to 2", (chunk) => chunks.push(chunk));

    expect(result.response).toContain("shell exploration");
    expect(chunks.join("")).not.toContain("RUN(");
    expect(chunks.join("")).not.toContain("cat .git/HEAD");

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("sanitizes pasted tool transcript noise before edit recovery prompts", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-engine-recovery-task-"));
    const targetPath = "src/app.ts";
    await fs.mkdir(path.join(tmp, "src"), { recursive: true });
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.writeFile(path.join(tmp, targetPath), "const answer = 1;\n", "utf8");

    const recoveryPrompts: string[] = [];
    const provider = new ScriptedProvider([""], (messages) => {
      const system = messages[0]?.content ?? "";
      if (system.includes("repairing a failed coding-agent edit loop")) {
        recoveryPrompts.push(messages[messages.length - 1]?.content ?? "");
        return "[]";
      }
      if (system.includes("repairing a stalled coding-agent edit turn")) {
        return "[]";
      }
      if (system.includes("Explain why the edit task failed")) {
        return "No valid edit tool call was produced.";
      }
      return "[]";
    });

    const engine = createEngineHarness(tmp, provider, createSelection(targetPath));
    await engine.runTurn(
      [
        "TOOLING(.)",
        "  L INFO Generated recovery tool calls from failed edit transcript",
        "READ(README.md)",
        "READ(package.json)",
        "READ(.git)",
        "",
        "look at this it fails here i mean for some reason i cant get my agent to edit any files like it always breaks look through the codebase and figure it out"
      ].join("\n"),
      () => {}
    );

    expect(recoveryPrompts.length).toBeGreaterThan(0);
    for (const prompt of recoveryPrompts) {
      expect(prompt).toContain("look at this it fails here");
      expect(prompt).not.toContain("READ(README.md)");
      expect(prompt).not.toContain("READ(package.json)");
      expect(prompt).not.toContain("READ(.git)");
    }

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("rejects directory read targets during edit recovery", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-engine-dir-read-"));
    const targetPath = "src/app.ts";
    await fs.mkdir(path.join(tmp, "src"), { recursive: true });
    await fs.mkdir(path.join(tmp, ".git"), { recursive: true });
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.writeFile(path.join(tmp, targetPath), "const answer = 1;\n", "utf8");

    const provider = new ScriptedProvider([""], (messages) => {
      const system = messages[0]?.content ?? "";
      if (system.includes("repairing a failed coding-agent edit loop")) {
        return '[{"tool":"read","path":".git","offset":1,"limit":20}]';
      }
      if (system.includes("repairing a stalled coding-agent edit turn")) {
        return "[]";
      }
      if (system.includes("Explain why the edit task failed")) {
        return "Edit recovery proposed an invalid directory read, so no file was changed.";
      }
      return "[]";
    });

    const engine = createEngineHarness(tmp, provider, createSelection(targetPath));
    const chunks: string[] = [];
    const result = await engine.runTurn("Fix src/app.ts by changing answer to 2", (chunk) => chunks.push(chunk));

    expect(result.response).toContain("invalid directory read");
    expect(chunks.join("")).not.toContain("READ(.git)");
    expect(chunks.join("")).not.toContain("EISDIR");

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("repairs malformed edit-task output into executable tool calls before transcript recovery", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-engine-edit-repair-"));
    const targetPath = "src/app.ts";
    await fs.mkdir(path.join(tmp, "src"), { recursive: true });
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.writeFile(path.join(tmp, targetPath), "const answer = 1;\n", "utf8");

    const provider = new ScriptedProvider(["READ_MARKER", "EDIT_MARKER", ""], (messages) => {
      const system = messages[0]?.content ?? "";
      if (system.includes("Convert assistant text into executable tool calls")) {
        const payload = messages[messages.length - 1]?.content ?? "";
        if (payload.includes("READ_MARKER")) {
          return '[{"tool":"read","path":"src/app.ts","offset":1,"limit":20}]';
        }
        if (payload.includes("EDIT_MARKER")) {
          return '[{"tool":"edit","path":"src/app.ts","edits":[{"oldText":"const answer = 1;","newText":"const answer = 2;"}]}]';
        }
        return "[]";
      }
      if (system.includes("Provide the final user-facing answer")) {
        return '<tool_calls>[{"tool":"read","path":"src/app.ts","offset":1,"limit":20}]</tool_calls>';
      }
      return "[]";
    });

    const engine = createEngineHarness(tmp, provider, createSelection(targetPath));
    const chunks: string[] = [];
    const result = await engine.runTurn("Fix src/app.ts by changing answer to 2", (chunk) => chunks.push(chunk));
    const updated = await fs.readFile(path.join(tmp, targetPath), "utf8");

    expect(updated).toContain("const answer = 2;");
    expect(result.response).toContain("Applied changes to src/app.ts.");

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("does not surface draft markdown rewrite prose after successful edit mutation", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-engine-post-mutation-draft-"));
    const targetPath = "README.md";
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.writeFile(path.join(tmp, targetPath), "# Demo\nold line\n", "utf8");

    const provider = new ScriptedProvider(
      [
        '<tool_calls>[{"tool":"edit","path":"README.md","edits":[{"oldText":"old line","newText":"new line"}]}]</tool_calls>',
        [
          "I'll now rewrite README:",
          "```markdown",
          "# Demo",
          "new line",
          "```"
        ].join("\n")
      ],
      (messages) => {
        const system = messages[0]?.content ?? "";
        if (system.includes("Provide the final user-facing answer")) {
          return "Updated README.md with the latest repository changes.";
        }
        return "[]";
      }
    );

    const engine = createEngineHarness(tmp, provider, createSelection(targetPath));
    const chunks: string[] = [];
    const result = await engine.runTurn("Update README from current git changes", (chunk) => chunks.push(chunk));
    const updated = await fs.readFile(path.join(tmp, targetPath), "utf8");

    expect(updated).toContain("new line");
    expect(result.response).toContain("Updated README.md with the latest repository changes.");
    expect(chunks.join("")).not.toContain("```markdown");

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("falls back to tool summary when final synthesis returns long fenced draft content", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-engine-summary-fallback-"));
    const targetPath = "README.md";
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.writeFile(path.join(tmp, targetPath), "# Demo\nold line\n", "utf8");

    const provider = new ScriptedProvider(
      ['<tool_calls>[{"tool":"edit","path":"README.md","edits":[{"oldText":"old line","newText":"new line"}]}]</tool_calls>', ""],
      (messages) => {
        const system = messages[0]?.content ?? "";
        if (system.includes("Provide the final user-facing answer")) {
          return [
            "```markdown",
            "# Demo",
            "new line",
            "```"
          ].join("\n");
        }
        return "[]";
      }
    );

    const engine = createEngineHarness(tmp, provider, createSelection(targetPath));
    const result = await engine.runTurn("Update README from current git changes", () => {});

    expect(result.response).toContain("Applied changes to README.md.");

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("applies deterministic README fallback for readme+git edit tasks when model never mutates", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-engine-readme-git-fallback-"));
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.writeFile(path.join(tmp, "README.md"), "# Demo\n\nInitial content.\n", "utf8");
    execSync("git init", { cwd: tmp, stdio: "ignore" });
    await fs.writeFile(path.join(tmp, "dummy.txt"), "pending\n", "utf8");

    const provider = new ScriptedProvider(["", "", ""], (messages) => {
      const system = messages[0]?.content ?? "";
      if (system.includes("Explain why the edit task failed")) {
        return "No edits were applied.";
      }
      if (system.includes("Provide the final user-facing answer")) {
        return "[]";
      }
      return "[]";
    });

    const engine = createEngineHarness(tmp, provider, createSelection("README.md"));
    const result = await engine.runTurn("Can you change the Readme file with the current changes which you can check with git", () => {});
    const updated = await fs.readFile(path.join(tmp, "README.md"), "utf8");

    expect(updated).toContain("## Current Repository Changes");
    expect(updated).toContain("dummy.txt");
    expect(result.response).toContain("Applied changes to README.md.");

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("suppresses no-valid-tool-call retry status lines from user-facing stream output", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-engine-retry-status-hidden-"));
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.writeFile(path.join(tmp, "README.md"), "# Demo\n\nInitial content.\n", "utf8");

    const provider = new ScriptedProvider(["", "", ""], (messages) => {
      const system = messages[0]?.content ?? "";
      if (system.includes("Explain why the edit task failed")) {
        return "No valid edit tool call was produced.";
      }
      return "[]";
    });

    const engine = createEngineHarness(tmp, provider, createSelection("README.md"));
    const chunks: string[] = [];
    await engine.runTurn("Update README using git changes", (chunk) => chunks.push(chunk));

    expect(chunks.join("")).not.toContain("Model returned no valid tool calls on edit task");
    expect(chunks.join("")).not.toContain("TOOLING(.)");

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("runs post-edit verification commands from detected package scripts", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-engine-post-edit-checks-"));
    const targetPath = "src/app.ts";
    await fs.mkdir(path.join(tmp, "src"), { recursive: true });
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.writeFile(path.join(tmp, targetPath), "const answer = 1;\n", "utf8");
    await fs.writeFile(
      path.join(tmp, "package.json"),
      JSON.stringify(
        {
          name: "post-edit-checks",
          type: "module",
          scripts: {
            build: `node -e "process.stdout.write('build-ok')"`
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const provider = new ScriptedProvider(
      ['<tool_calls>[{"tool":"edit","path":"src/app.ts","edits":[{"oldText":"const answer = 1;","newText":"const answer = 2;"}]}]</tool_calls>'],
      (messages) => {
        const system = messages[0]?.content ?? "";
        if (system.includes("Provide the final user-facing answer")) {
          return "Updated src/app.ts.";
        }
        return "[]";
      }
    );

    const engine = createEngineHarness(tmp, provider, createSelection(targetPath));
    const chunks: string[] = [];
    await engine.runTurn("Fix src/app.ts by changing answer to 2", (chunk) => chunks.push(chunk));

    const transcript = chunks.join("");
    expect(transcript).toContain("* BASH(\"npm run build\")");
    expect(transcript).toContain("build-ok");

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("executes model-issued shell commands and reports their output", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-engine-command-"));
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    const command = `"${process.execPath}" -e "process.stdout.write('hello from shell')"`;

    const provider = new ScriptedProvider(
      [`<tool_calls>${JSON.stringify([{ tool: "run_command", command, timeout_ms: 5000 }])}</tool_calls>`],
      (messages) => {
        const system = messages[0]?.content ?? "";
        if (system.includes("Provide the final user-facing answer")) {
          return "Executed the command and captured its output.";
        }
        return "[]";
      }
    );

    const engine = createEngineHarness(tmp, provider, createSelectionForPaths([]));
    const chunks: string[] = [];
    const result = await engine.runTurn("Run a shell command", (chunk) => chunks.push(chunk));

    expect(result.response).toContain("Executed the command");
    expect(chunks.join("")).toContain("BASH(");
    expect(chunks.join("")).toContain("hello from shell");

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("executes relaxed bracketed tool-call blocks without leaking them to the final response", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-engine-bracketed-"));
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    const command = `"${process.execPath}" -e "process.stdout.write(String(42))"`;

    const provider = new ScriptedProvider(
      [`[TOOL_CALL]\n{tool: "run_command", command: ${JSON.stringify(command)}, timeout_ms: 5000}\n[/TOOL_CALL]`],
      (messages) => {
        const system = messages[0]?.content ?? "";
        if (system.includes("Provide the final user-facing answer")) {
          return "Executed repository inspection successfully.";
        }
        return "[]";
      }
    );

    const engine = createEngineHarness(tmp, provider, createSelectionForPaths([]));
    const chunks: string[] = [];
    const result = await engine.runTurn("Check git status and inspect the repo", (chunk) => chunks.push(chunk));

    expect(result.response).toContain("Executed repository inspection successfully");
    expect(chunks.join("")).toContain("BASH(");
    expect(chunks.join("")).toContain("42");
    expect(chunks.join("")).not.toContain("[TOOL_CALL]");
    expect(chunks.join("")).not.toContain('{tool: "run_command"');

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("shows raw token counts in context footer when usage is below one thousand tokens", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-engine-contextline-"));
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });

    const provider = new ScriptedProvider(["Context loaded."], () => "[]");
    const engine = createEngineHarness(tmp, provider, createSelectionForPaths(["src/app.ts"]));
    const result = await engine.runTurn("Explain the current file", () => {});

    expect(result.contextLine).toContain("context: normal / 120t used");
    expect(result.contextLine).toContain("saved ~0t");

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("forced mutation recovery can reread an already-read target to refresh the transcript tail", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-engine-reread-"));
    const targetPath = "src/commands/builtins.ts";
    await fs.mkdir(path.join(tmp, "src", "commands"), { recursive: true });
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, targetPath),
      "export function buildBuiltinCommands() {\n  return [];\n}\n",
      "utf8"
    );

    const provider = new ScriptedProvider([], (messages) => {
      const system = messages[0]?.content ?? "";
      const transcript = messages[messages.length - 1]?.content ?? "";
      if (system.includes("repairing a stalled coding-agent edit turn")) {
        if (transcript.includes("[forced read]") && transcript.includes("read_file src/commands/builtins.ts")) {
          return '[{"tool":"replace_in_file","path":"src/commands/builtins.ts","find":"return [];","replace":"return [{ name: \\"usage\\" }];"}]';
        }
        return "[]";
      }
      return "[]";
    });

    const engine = createEngineHarness(tmp, provider, createSelection(targetPath)) as TokiEngine & Record<string, any>;
    const task = {
      raw: "Make a /usage command and wire it into builtins.",
      objective: "Make a /usage command and wire it into builtins.",
      intent: "implement_feature",
      entities: { paths: [], symbols: [], errors: [], domains: ["cli", "tool"] },
      risk: "low",
      needsEdit: true,
      needsTests: false,
      confidence: 0.9
    };
    const toolResults = [
      "[round 1]",
      "read_file src/commands/builtins.ts lines 1-20",
      "1: export function buildBuiltinCommands() {",
      "2:   return [];",
      "3: }"
    ].join("\n");

    const recovery = await engine.attemptForcedMutationRecovery(
      provider,
      task,
      createSelection(targetPath).items,
      new Set<string>(),
      toolResults,
      () => {}
    );

    const updated = await fs.readFile(path.join(tmp, targetPath), "utf8");
    expect(recovery.mutationSuccessCount).toBe(1);
    expect(updated).toContain('{ name: "usage" }');

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("forced recovery read selection skips generated transcript paths and prefers source context", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-engine-generated-read-"));
    await fs.mkdir(path.join(tmp, "src", "core"), { recursive: true });
    await fs.mkdir(path.join(tmp, "dist"), { recursive: true });
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.writeFile(path.join(tmp, "src", "core", "engine.ts"), "export const engine = true;\n", "utf8");
    await fs.writeFile(path.join(tmp, "dist", "index.js"), "export {};\n", "utf8");

    const provider = new ScriptedProvider([], () => "[]");
    const engine = createEngineHarness(tmp, provider, createSelectionForPaths(["src/core/engine.ts"])) as TokiEngine & Record<string, any>;
    const task = {
      raw: "Debug the coding agent failure from this pasted transcript and fix it.",
      objective: "Debug the coding agent failure from this pasted transcript and fix it.",
      intent: "debug_and_fix",
      entities: {
        paths: ["dist/index.js", "a/README.md", "b/README.md"],
        symbols: ["EDIT", "README"],
        errors: [],
        domains: ["cli", "engine", "tool", "broker"]
      },
      risk: "low",
      needsEdit: true,
      needsTests: true,
      confidence: 0.9
    };

    const calls = await engine.buildForcedRecoveryReadCalls(task, createSelectionForPaths(["src/core/engine.ts"]).items, new Set<string>(), "(none)");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tool: "read", path: "src/core/engine.ts" });

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("keeps repairing edit-task prose after a partial mutation instead of treating it as the final answer", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-engine-partial-edit-"));
    const targetPath = "README.md";
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, targetPath),
      [
        "# Demo",
        "",
        "## Project Structure",
        "- packages/",
        "- src/",
        "",
        "## Architecture",
        "Old architecture text."
      ].join("\n"),
      "utf8"
    );

    const provider = new ScriptedProvider(
      [
        '<tool_calls>[{"tool":"edit","path":"README.md","edits":[{"oldText":"- src/","newText":"- src/\\n- tests/"}]}]</tool_calls>',
        [
          "Update the architecture section too:",
          "## Architecture",
          "The coding agent now uses separate Pi-style tool files."
        ].join("\n")
      ],
      (messages) => {
        const system = messages[0]?.content ?? "";
        if (system.includes("Convert assistant text into executable tool calls")) {
          return '[{"tool":"edit","path":"README.md","edits":[{"oldText":"Old architecture text.","newText":"The coding agent now uses separate Pi-style tool files."}]}]';
        }
        if (system.includes("Provide the final user-facing answer")) {
          return "Updated README.md to reflect the new tool architecture.";
        }
        return "[]";
      }
    );

    const engine = createEngineHarness(tmp, provider, createSelection(targetPath)) as TokiEngine & Record<string, any>;
    engine.config.global.runtime.maxToolRounds = 2;

    const result = await engine.runTurn("Update README.md to describe the new Pi-style tool architecture", () => {});
    const updated = await fs.readFile(path.join(tmp, targetPath), "utf8");

    expect(updated).toContain("- tests/");
    expect(updated).toContain("The coding agent now uses separate Pi-style tool files.");
    expect(result.response).toContain("Updated README.md");
    expect(result.response).not.toContain("Update the architecture section too");

    await fs.rm(tmp, { recursive: true, force: true });
  });
});
