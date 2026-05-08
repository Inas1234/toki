import { ChatChunk, ChatResult, ModelInfo, ProviderChatMessage, ProviderChatOptions } from "@toki/shared";

export interface ModelProvider {
  id: string;
  name: string;
  listModels(): Promise<ModelInfo[]>;
  chat(messages: ProviderChatMessage[], options: ProviderChatOptions): Promise<ChatResult>;
  streamChat(messages: ProviderChatMessage[], options: ProviderChatOptions): AsyncGenerator<ChatChunk>;
  estimateTokens(text: string): number;
  getUsage?(): Promise<ProviderUsageInfo>;
}

export interface ProviderUsageInfo {
  providerId?: string;
  endpoint?: string;
  planName?: string;
  usedTokens?: number;
  usedDollars?: number;
  remainingTokens?: number;
  remainingDollars?: number;
  resetAt?: string;
}
