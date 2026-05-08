import { readFileSync } from "node:fs";
import { ChatChunk, ChatResult, ModelInfo, ProviderChatMessage, ProviderChatOptions } from "@toki/shared";
import { ModelProvider } from "./base.js";

interface ScriptedProviderRule {
  whenSystemIncludes?: string;
  whenLastUserIncludes?: string;
  response: string;
}

interface ScriptedProviderFixture {
  models?: ModelInfo[];
  streamResponses?: string[];
  chatRules?: ScriptedProviderRule[];
  defaultChatResponse?: string;
}

function matchesRule(rule: ScriptedProviderRule, messages: ProviderChatMessage[]): boolean {
  const system = messages[0]?.content ?? "";
  const lastUser = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";

  if (rule.whenSystemIncludes && !system.includes(rule.whenSystemIncludes)) {
    return false;
  }
  if (rule.whenLastUserIncludes && !lastUser.includes(rule.whenLastUserIncludes)) {
    return false;
  }
  return true;
}

export class ScriptedProvider implements ModelProvider {
  public readonly id = "scripted";
  public readonly name = "Scripted";
  private readonly fixture: ScriptedProviderFixture;
  private readonly streamResponses: string[];

  public constructor(fixturePath: string) {
    const raw = readFileSync(fixturePath, "utf8");
    this.fixture = JSON.parse(raw) as ScriptedProviderFixture;
    this.streamResponses = [...(this.fixture.streamResponses ?? [])];
  }

  public async listModels(): Promise<ModelInfo[]> {
    return this.fixture.models ?? [{ id: "scripted-model", label: "scripted-model" }];
  }

  public async chat(messages: ProviderChatMessage[], options: ProviderChatOptions): Promise<ChatResult> {
    const matched = this.fixture.chatRules?.find((rule) => matchesRule(rule, messages));
    return {
      text: matched?.response ?? this.fixture.defaultChatResponse ?? "[]",
      model: options.model
    };
  }

  public async *streamChat(
    _messages: ProviderChatMessage[],
    _options: ProviderChatOptions
  ): AsyncGenerator<ChatChunk> {
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
