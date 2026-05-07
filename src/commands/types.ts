import { BudgetMode, ContextReceipt, ModelInfo } from "../core/types.js";

export interface SecretPrompt {
  providerId: string;
  fieldKey: string;
  label: string;
  masked?: boolean;
}

export interface SelectionPromptOption {
  id: string;
  label: string;
  description?: string;
}

export interface SelectionPrompt {
  kind: "provider" | "model";
  title: string;
  options: SelectionPromptOption[];
}

export interface CommandContext {
  getReceipt(): ContextReceipt | undefined;
  explainPath(path: string): string;
  pin(path: string): void;
  drop(path: string): void;
  clearConversation(): void;
  getBudgetSummary(): { mode: BudgetMode; used: number; ceiling: number };
  setMode(mode: BudgetMode): void;
  getMode(): BudgetMode;
  getCurrentModel(): string;
  setModel(model: string): Promise<void>;
  listModels(): Promise<ModelInfo[]>;
  getCurrentProvider(): string;
  listProviders(): Array<{ id: string; name: string; configured: boolean }>;
  switchProvider(providerId: string): Promise<void>;
  exit(): void;
  providerNeedsCredentials(providerId: string): boolean;
  getProviderRequirements(providerId: string): Array<{ key: string; label: string; masked?: boolean }>;
  setProviderCredential(providerId: string, fieldKey: string, value: string): Promise<void>;
}

export interface CommandResult {
  handled: boolean;
  output: string;
  error?: boolean;
  promptForSecret?: SecretPrompt;
  promptForSelection?: SelectionPrompt;
}

export interface CommandHandler {
  name: string;
  description: string;
  usage: string;
  run(args: string, context: CommandContext): Promise<CommandResult>;
}
