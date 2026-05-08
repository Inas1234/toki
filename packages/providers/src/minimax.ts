import { ChatChunk, ChatResult, ModelInfo, ProviderChatMessage, ProviderChatOptions, estimateTokens } from "@toki/shared";
import { ModelProvider, ProviderUsageInfo } from "./base.js";

interface MiniMaxProviderOptions {
  apiKey?: string;
  baseUrl?: string;
}

interface CompletionChoiceDelta {
  content?: string;
  reasoning?: string;
  reasoning_content?: string;
}

interface CompletionChunk {
  choices?: Array<{
    delta?: CompletionChoiceDelta;
    finish_reason?: string | null;
  }>;
}

interface MiniMaxModelDescriptor {
  id?: string;
}

interface MiniMaxModelsResponse {
  data?: MiniMaxModelDescriptor[];
}

const DEFAULT_BASE_URL = "https://api.minimax.io/v1";

interface MiniMaxUsageResponse {
  usage?: {
    total_tokens?: number;
    used_tokens?: number;
  };
  remaining?: {
    tokens?: number;
  };
  group_info?: {
    used_dollars?: number;
    remaining_dollars?: number;
  };
  model_remains?: Array<{
    model_name?: string;
    remaining_tokens?: number;
    used_tokens?: number;
    start_time?: string | number;
    end_time?: string | number;
  }>;
  plan_name?: string;
  subscription_name?: string;
  reset_at?: string | number;
  end_time?: string | number;
}
const DOCUMENTED_MODELS = [
  "MiniMax-M2.7",
  "MiniMax-M2.7-highspeed",
  "MiniMax-M2.5",
  "MiniMax-M2.5-highspeed",
  "MiniMax-M2.1",
  "MiniMax-M2.1-highspeed",
  "MiniMax-M2"
];

function parseSseEvents(buffer: string): { events: string[]; rest: string } {
  const chunks = buffer.split(/\r?\n\r?\n/);
  const rest = chunks.pop() ?? "";
  return { events: chunks, rest };
}

export class MiniMaxProvider implements ModelProvider {
  public readonly id = "minimax";
  public readonly name = "MiniMax";
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  public constructor(options: MiniMaxProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.MINIMAX_API_KEY;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  private requireApiKey(): string {
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new Error("MiniMax API key missing. Use /provider minimax and enter your API key.");
    }
    return this.apiKey;
  }

  private getHeaders(apiKey: string): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    };
  }

  private normalizeMessages(messages: ProviderChatMessage[]): ProviderChatMessage[] {
    const systemMessages = messages.filter((item) => item.role === "system").map((item) => item.content.trim()).filter(Boolean);
    const nonSystemMessages = messages.filter((item) => item.role !== "system");
    if (systemMessages.length <= 1) {
      return messages;
    }
    return [
      {
        role: "system",
        content: systemMessages.join("\n\n")
      },
      ...nonSystemMessages
    ];
  }

  public async listModels(): Promise<ModelInfo[]> {
    const apiKey = this.requireApiKey();
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers: this.getHeaders(apiKey)
      });

      if (!response.ok) {
        throw new Error(`MiniMax models fetch failed (${response.status})`);
      }

      const payload = (await response.json()) as MiniMaxModelsResponse;
      const models = payload.data ?? [];
      const deduped = new Map<string, ModelInfo>();

      for (const model of models) {
        if (!model.id) {
          continue;
        }
        deduped.set(model.id, {
          id: model.id,
          label: model.id
        });
      }

      const listed = [...deduped.values()].sort((left, right) => left.id.localeCompare(right.id));
      if (listed.length > 0) {
        return listed;
      }
    } catch {
      // Fallback to documented model IDs when listing is not available.
    }

    return DOCUMENTED_MODELS.map((id) => ({ id, label: id }));
  }

  public async chat(messages: ProviderChatMessage[], options: ProviderChatOptions): Promise<ChatResult> {
    const apiKey = this.requireApiKey();
    const normalizedMessages = this.normalizeMessages(messages);
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.getHeaders(apiKey),
      body: JSON.stringify({
        model: options.model,
        messages: normalizedMessages,
        stream: false,
        temperature: options.temperature ?? 0.2,
        max_completion_tokens: options.maxTokens
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`MiniMax chat failed (${response.status}): ${body}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = payload.choices?.[0]?.message?.content ?? "";
    const result: ChatResult = {
      text,
      model: options.model
    };
    if (typeof payload.usage?.prompt_tokens === "number") {
      result.inputTokens = payload.usage.prompt_tokens;
    }
    if (typeof payload.usage?.completion_tokens === "number") {
      result.outputTokens = payload.usage.completion_tokens;
    }
    return result;
  }

  public async *streamChat(
    messages: ProviderChatMessage[],
    options: ProviderChatOptions
  ): AsyncGenerator<ChatChunk> {
    const apiKey = this.requireApiKey();
    const normalizedMessages = this.normalizeMessages(messages);
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.getHeaders(apiKey),
      body: JSON.stringify({
        model: options.model,
        messages: normalizedMessages,
        stream: true,
        temperature: options.temperature ?? 0.2,
        max_completion_tokens: options.maxTokens
      })
    });

    if (!response.ok || !response.body) {
      const body = await response.text();
      throw new Error(`MiniMax stream failed (${response.status}): ${body}`);
    }

    const decoder = new TextDecoder("utf-8");
    const reader = response.body.getReader();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseEvents(buffer);
      buffer = rest;
      for (const event of events) {
        const lines = event
          .split(/\r?\n/)
          .map((line) => line.trimEnd())
          .filter((line) => line.startsWith("data:"));
        if (lines.length === 0) {
          continue;
        }

        const data = lines.map((line) => line.replace(/^data:\s*/, "")).join("\n").trim();
        if (data.length === 0) {
          continue;
        }
        if (data === "[DONE]") {
          yield { text: "", done: true };
          return;
        }

        let parsed: CompletionChunk;
        try {
          parsed = JSON.parse(data) as CompletionChunk;
        } catch {
          continue;
        }

        const delta = parsed.choices?.[0]?.delta;
        if (delta?.reasoning_content ?? delta?.reasoning) {
          yield { text: delta.reasoning_content ?? delta.reasoning ?? "", done: false, channel: "reasoning" };
        }
        if (delta?.content) {
          yield { text: delta.content, done: false, channel: "content" };
        }
        const doneReason = parsed.choices?.[0]?.finish_reason;
        if (doneReason) {
          yield { text: "", done: true };
          return;
        }
      }
    }

    yield { text: "", done: true };
  }

  public estimateTokens(text: string): number {
    return estimateTokens(text);
  }

  public async getUsage(): Promise<ProviderUsageInfo> {
    const apiKey = this.requireApiKey();
    const endpoints = ["/token_plan/remains", "/api/openplatform/coding_plan/remains"];
    let lastError = "Unknown usage endpoint error";

    for (const endpoint of endpoints) {
      try {
        const response = await fetch(`${this.baseUrl}${endpoint}`, {
          method: "GET",
          headers: this.getHeaders(apiKey)
        });
        if (!response.ok) {
          lastError = `MiniMax usage failed (${response.status})`;
          continue;
        }
        const payload = (await response.json()) as MiniMaxUsageResponse;
        const usage = this.parseUsagePayload(payload);
        return {
          providerId: this.id,
          endpoint: endpoint,
          ...usage
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    throw new Error(`MiniMax usage unavailable: ${lastError}`);
  }

  private parseUsagePayload(payload: MiniMaxUsageResponse): ProviderUsageInfo {
    const modelRemains = Array.isArray(payload.model_remains) ? payload.model_remains : [];
    const aggregateRemaining = modelRemains.reduce((sum, item) => sum + (this.toNumber(item.remaining_tokens) ?? 0), 0);
    const aggregateUsed = modelRemains.reduce((sum, item) => sum + (this.toNumber(item.used_tokens) ?? 0), 0);
    const planName =
      payload.plan_name ??
      payload.subscription_name ??
      modelRemains[0]?.model_name;

    const resetRaw = payload.reset_at ?? payload.end_time ?? modelRemains[0]?.end_time;
    const usedTokens = this.toNumber(payload.usage?.used_tokens) ?? this.toNumber(payload.usage?.total_tokens) ?? (aggregateUsed > 0 ? aggregateUsed : undefined);
    const remainingTokens = this.toNumber(payload.remaining?.tokens) ?? (aggregateRemaining > 0 ? aggregateRemaining : undefined);
    const usedDollars = this.toNumber(payload.group_info?.used_dollars);
    const remainingDollars = this.toNumber(payload.group_info?.remaining_dollars);
    const resetAt = this.toIsoString(resetRaw);
    const usage: ProviderUsageInfo = {};
    if (typeof planName === "string" && planName.length > 0) {
      usage.planName = planName;
    }
    if (typeof usedTokens === "number") {
      usage.usedTokens = usedTokens;
    }
    if (typeof remainingTokens === "number") {
      usage.remainingTokens = remainingTokens;
    }
    if (typeof usedDollars === "number") {
      usage.usedDollars = usedDollars;
    }
    if (typeof remainingDollars === "number") {
      usage.remainingDollars = remainingDollars;
    }
    if (typeof resetAt === "string" && resetAt.length > 0) {
      usage.resetAt = resetAt;
    }
    return usage;
  }

  private toNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return undefined;
  }

  private toIsoString(value: unknown): string | undefined {
    if (typeof value === "string") {
      const asDate = new Date(value);
      return Number.isNaN(asDate.getTime()) ? value : asDate.toISOString();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      const ms = value > 10_000_000_000 ? value : value * 1000;
      const asDate = new Date(ms);
      return Number.isNaN(asDate.getTime()) ? undefined : asDate.toISOString();
    }
    return undefined;
  }
}
