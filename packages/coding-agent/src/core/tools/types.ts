import type { ToolCall, ToolName } from "@toki/agent-core";

export type { ToolCall, ToolName } from "@toki/agent-core";

export type ToolCallByName<T extends ToolName> = Extract<ToolCall, { tool: T }>;

export interface ToolExecutionContext {
  repoDir: string;
}

export interface ToolExecutionResult {
  action: string;
  displayLines: string[];
  report: string;
  mutationSuccessCount: number;
}

export interface ToolDefinition<T extends ToolCall = ToolCall> {
  name: T["tool"];
  description: string;
  promptSnippet: string;
  promptGuidelines?: string[];
  execute(call: T, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}
