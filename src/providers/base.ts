import { ChatChunk, ChatResult, ModelInfo, ProviderChatMessage, ProviderChatOptions } from "../core/types.js";

export interface ModelProvider {
  id: string;
  name: string;
  listModels(): Promise<ModelInfo[]>;
  chat(messages: ProviderChatMessage[], options: ProviderChatOptions): Promise<ChatResult>;
  streamChat(messages: ProviderChatMessage[], options: ProviderChatOptions): AsyncGenerator<ChatChunk>;
  estimateTokens(text: string): number;
}
