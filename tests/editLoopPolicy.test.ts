import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { describe, expect, test } from "vitest";
import { TokiEngine } from "../src/core/engine.js";
import { ContextItem, ContextReceipt, GlobalConfig, ProviderChatMessage, RepoConfig } from "../src/core/types.js";
import { ModelProvider } from "../src/providers/base.js";

class CountingProvider implements ModelProvider {
  public readonly id = "counting";
  public readonly name = "Counting";
  public streamCalls = 0;
  private readonly streamResponses: string[];
  private readonly chatHandler: (messages: ProviderChatMessage[]) => string;

  public constructor(streamResponses: string[], chatHandler: (messages: ProviderChatMessage[]) => string) {
    this.streamResponses = [...streamResponses];
    this.chatHandler = chatHandler;
  }

  public async listModels() {
    return [{ id: "counting-model", label: "counting-model" }];
  }

  public async chat(messages: ProviderChatMessage[]) {
    return {
      text: this.chatHandler(messages),
      model: "counting-model"
    };
  }

  public async *streamChat(): AsyncGenerator<{ text: string; done: boolean; channel?: "content" | "reasoning" }> {
    this.streamCalls += 1;
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
      defaultModel: "counting-model",
      defaultProvider: "counting",
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
        maxToolRounds: 6,
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
        id: `${targetPath}:full`,
        type: "file",
        path: targetPath,
        representation: "full_file",
        content: "export const answer = 1;\n",
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

function createEngineHarness(
  tmp: string,
  provider: ModelProvider,
  selection: { items: ContextItem[]; receipt: ContextReceipt }
): TokiEngine {
  const engine = new TokiEngine() as TokiEngine & Record<string, any>;
  const config = createConfig(tmp);
  engine.config = config;
  engine.providerId = "counting";
  engine.modelId = "counting-model";
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

describe("edit loop policy", () => {
  test("caps repeated search-only rounds and escalates to a concrete edit path", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "toki-edit-policy-"));
    const targetPath = "src/app.ts";
    await fs.mkdir(path.join(tmp, "src"), { recursive: true });
    await fs.mkdir(path.join(tmp, ".toki", "index"), { recursive: true });
    await fs.writeFile(path.join(tmp, targetPath), "export const answer = 1;\n", "utf8");

    const repeatedSearch = '<tool_calls>[{"tool":"search_files","path":"src","query":"answer constant","max_results":5}]</tool_calls>';
    const provider = new CountingProvider(new Array(6).fill(repeatedSearch), (messages) => {
      const system = messages[0]?.content ?? "";
      const transcript = messages[messages.length - 1]?.content ?? "";
      if (system.includes("repairing a stalled coding-agent edit turn")) {
        if (transcript.includes("read_file src/app.ts")) {
          return '[{"tool":"edit","path":"src/app.ts","edits":[{"oldText":"export const answer = 1;","newText":"export const answer = 2;"}]}]';
        }
        return "[]";
      }
      if (system.includes("Provide the final user-facing answer")) {
        return "Updated src/app.ts to use answer = 2.";
      }
      return "[]";
    });

    const engine = createEngineHarness(tmp, provider, createSelection(targetPath));
    const chunks: string[] = [];
    const result = await engine.runTurn("Fix src/app.ts by changing answer to 2", (chunk) => chunks.push(chunk));

    const updated = await fs.readFile(path.join(tmp, targetPath), "utf8");
    expect(updated).toContain("export const answer = 2;");
    expect(result.response).toContain("Updated src/app.ts");
    expect(provider.streamCalls).toBeLessThanOrEqual(3);

    await fs.rm(tmp, { recursive: true, force: true });
  });
});
