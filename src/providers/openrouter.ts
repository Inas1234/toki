import { estimateTokens } from "../utils/tokens.js";
import { ChatChunk, ChatResult, ModelInfo, ProviderChatMessage, ProviderChatOptions } from "../core/types.js";
import { ModelProvider } from "./base.js";

interface OpenRouterProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  appName?: string;
  siteUrl?: string;
}

interface CompletionChoiceDelta {
  content?: string;
  reasoning?: string;
}

interface CompletionChunk {
  choices?: Array<{
    delta?: CompletionChoiceDelta;
    finish_reason?: string | null;
  }>;
}

interface OpenRouterModelDescriptor {
  id?: string;
  context_length?: number;
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModelDescriptor[];
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

function parseSseEvents(buffer: string): { events: string[]; rest: string } {
  const chunks = buffer.split(/\r?\n\r?\n/);
  const rest = chunks.pop() ?? "";
  return { events: chunks, rest };
}

export class OpenRouterProvider implements ModelProvider {
  public readonly id = "openrouter";
  public readonly name = "OpenRouter";
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly appName: string;
  private readonly siteUrl: string;

  public constructor(options: OpenRouterProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.appName = options.appName ?? process.env.OPENROUTER_APP_NAME ?? "Toki CLI";
    this.siteUrl = options.siteUrl ?? process.env.OPENROUTER_SITE_URL ?? "https://localhost";
  }

  private requireApiKey(): string {
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new Error("OpenRouter API key missing. Use /provider openrouter and enter your API key.");
    }
    return this.apiKey;
  }

  private getHeaders(apiKey: string): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": this.siteUrl,
      "X-Title": this.appName
    };
  }

  public async listModels(): Promise<ModelInfo[]> {
    const apiKey = this.requireApiKey();
    const response = await fetch(`${this.baseUrl}/models`, {
      method: "GET",
      headers: this.getHeaders(apiKey)
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenRouter models fetch failed (${response.status}): ${body}`);
    }

    const payload = (await response.json()) as OpenRouterModelsResponse;
    const models = payload.data ?? [];
    const deduped = new Map<string, ModelInfo>();

    for (const model of models) {
      if (!model.id) {
        continue;
      }
      deduped.set(model.id, {
        id: model.id,
        label: model.id,
        ...(typeof model.context_length === "number" ? { contextWindow: model.context_length } : {})
      });
    }

    return [...deduped.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  public async chat(messages: ProviderChatMessage[], options: ProviderChatOptions): Promise<ChatResult> {
    const apiKey = this.requireApiKey();
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.getHeaders(apiKey),
      body: JSON.stringify({
        model: options.model,
        messages,
        stream: false,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenRouter chat failed (${response.status}): ${body}`);
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
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.getHeaders(apiKey),
      body: JSON.stringify({
        model: options.model,
        messages,
        stream: true,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens
      })
    });

    if (!response.ok || !response.body) {
      const body = await response.text();
      throw new Error(`OpenRouter stream failed (${response.status}): ${body}`);
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
        if (delta?.reasoning) {
          yield { text: delta.reasoning, done: false, channel: "reasoning" };
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
}
