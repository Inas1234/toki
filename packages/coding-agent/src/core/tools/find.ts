import path from "node:path";
import { listFilesRecursive } from "@toki/shared";
import type { ToolCallByName, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { clampLimit, globToRegExp, resolveWorkspacePath } from "./helpers.js";

const DEFAULT_LIMIT = 1000;

export interface FindOperations {
  listFilesRecursive: (absolutePath: string) => Promise<string[]>;
}

const defaultOperations: FindOperations = {
  listFilesRecursive
};

export interface FindToolOptions {
  operations?: FindOperations;
}

function isIgnored(relativePath: string): boolean {
  return relativePath.startsWith("node_modules/") || relativePath.startsWith(".git/");
}

export function createFindToolDefinition(cwd: string, options?: FindToolOptions): ToolDefinition<ToolCallByName<"find">> {
  const ops = options?.operations ?? defaultOperations;
  return {
    name: "find",
    description: "Search for files by glob pattern.",
    promptSnippet: "Find files by glob pattern (respects .gitignore)",
    async execute(call: ToolCallByName<"find">, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
      const searchRoot = resolveWorkspacePath(cwd, call.path ?? ".");
      const pattern = globToRegExp(call.pattern);
      const max = clampLimit(call.limit, 5000, DEFAULT_LIMIT);
      const files = await ops.listFilesRecursive(searchRoot);
      const matches = files
        .map((filePath) => path.relative(searchRoot, filePath).replace(/\\/g, "/"))
        .filter((relativePath) => !isIgnored(relativePath) && pattern.test(relativePath))
        .sort((left, right) => left.localeCompare(right))
        .slice(0, max);

      return {
        action: `FIND(${JSON.stringify(call.pattern)})`,
        displayLines: [`  L FOUND ${matches.length} file(s) for pattern "${call.pattern}"`],
        report: `find ${call.path ?? "."} pattern="${call.pattern}"\n${matches.join("\n") || "(none)"}`,
        mutationSuccessCount: 0
      };
    }
  };
}

export function createFindTool(cwd: string, options?: FindToolOptions): ToolDefinition<ToolCallByName<"find">> {
  return createFindToolDefinition(cwd, options);
}
