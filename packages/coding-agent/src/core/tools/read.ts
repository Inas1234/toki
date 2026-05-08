import { fileExists, readTextFile } from "@toki/shared";
import type { ToolCallByName, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { resolveWorkspacePath } from "./helpers.js";

const DEFAULT_LIMIT = 200;

export interface ReadOperations {
  fileExists: (absolutePath: string) => Promise<boolean>;
  readTextFile: (absolutePath: string) => Promise<string>;
}

const defaultOperations: ReadOperations = {
  fileExists,
  readTextFile
};

export interface ReadToolOptions {
  operations?: ReadOperations;
}

export function createReadToolDefinition(cwd: string, options?: ReadToolOptions): ToolDefinition<ToolCallByName<"read">> {
  const ops = options?.operations ?? defaultOperations;
  return {
    name: "read",
    description: "Read the contents of a file.",
    promptSnippet: "Read file contents",
    async execute(call: ToolCallByName<"read">, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
      const absolutePath = resolveWorkspacePath(cwd, call.path);
      if (!(await ops.fileExists(absolutePath))) {
        throw new Error("target file does not exist");
      }
      const content = await ops.readTextFile(absolutePath);
      const lines = content.split(/\r?\n/);
      const start = Math.max(1, call.offset ?? 1);
      const end = Math.min(lines.length, start + (call.limit ?? DEFAULT_LIMIT) - 1);
      const rendered = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n");

      return {
        action: `READ(${call.path})`,
        displayLines: [`  L READ ${call.path} (${start}-${end})`],
        report: `read ${call.path} lines ${start}-${end}\n${rendered}`,
        mutationSuccessCount: 0
      };
    }
  };
}

export function createReadTool(cwd: string, options?: ReadToolOptions): ToolDefinition<ToolCallByName<"read">> {
  return createReadToolDefinition(cwd, options);
}
