import type { ToolCall } from "@toki/agent-core";
import { createAllTools } from "./tools/index.js";

export interface ToolExecutionOutput {
  display: string;
  report: string;
  mutationSuccessCount: number;
  errors: string[];
}

export async function executeToolCalls(cwd: string, calls: ToolCall[]): Promise<ToolExecutionOutput> {
  const tools = createAllTools(cwd);
  const displayLines: string[] = [];
  const reportLines: string[] = [];
  const errors: string[] = [];
  let mutationSuccessCount = 0;

  for (const call of calls) {
    try {
      const tool = tools[call.tool];
      const result = await tool.execute(call as never, { repoDir: cwd });
      displayLines.push(`* ${result.action}`);
      displayLines.push(...result.displayLines);
      reportLines.push(result.report);
      mutationSuccessCount += result.mutationSuccessCount;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      displayLines.push(`* ${String(call.tool).toUpperCase()}(${("path" in call && call.path) || "."})`);
      displayLines.push(`  L ERROR: ${message}`);
      reportLines.push(`error ${call.tool} ${"path" in call ? call.path ?? "." : "."}: ${message}`);
      errors.push(`${call.tool} ${"path" in call ? call.path ?? "." : "."}: ${message}`);
    }
  }

  return {
    display: displayLines.join("\n"),
    report: reportLines.join("\n"),
    mutationSuccessCount,
    errors
  };
}
