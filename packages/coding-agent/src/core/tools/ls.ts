import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ToolCallByName, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { clampLimit, resolveWorkspacePath } from "./helpers.js";

const DEFAULT_LIMIT = 500;

export interface LsOperations {
  readdir: typeof readdir;
  stat: typeof stat;
}

const defaultOperations: LsOperations = {
  readdir,
  stat
};

export interface LsToolOptions {
  operations?: LsOperations;
}

export function createLsToolDefinition(cwd: string, options?: LsToolOptions): ToolDefinition<ToolCallByName<"ls">> {
  const ops = options?.operations ?? defaultOperations;
  return {
    name: "ls",
    description: "List directory contents.",
    promptSnippet: "List directory contents",
    async execute(call: ToolCallByName<"ls">, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
      const targetPath = resolveWorkspacePath(cwd, call.path ?? ".");
      const targetStat = await ops.stat(targetPath);
      if (!targetStat.isDirectory()) {
        throw new Error(`Not a directory: ${call.path ?? "."}`);
      }

      const entries = await ops.readdir(targetPath, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      const limited = entries.slice(0, clampLimit(call.limit, 2000, DEFAULT_LIMIT));
      const formatted = limited.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));

      return {
        action: `LS(${call.path ?? "."})`,
        displayLines: [`  L LISTED ${formatted.length} entr${formatted.length === 1 ? "y" : "ies"}`],
        report: `ls ${call.path ?? "."}\n${formatted.join("\n") || "(empty directory)"}`,
        mutationSuccessCount: 0
      };
    }
  };
}

export function createLsTool(cwd: string, options?: LsToolOptions): ToolDefinition<ToolCallByName<"ls">> {
  return createLsToolDefinition(cwd, options);
}
