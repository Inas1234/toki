import path from "node:path";
import { fileExists, readTextFile, writeTextFile } from "@toki/shared";
import type { ToolCallByName, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { renderDiff, resolveWorkspacePath } from "./helpers.js";

export interface WriteOperations {
  fileExists: (absolutePath: string) => Promise<boolean>;
  readTextFile: (absolutePath: string) => Promise<string>;
  writeTextFile: (absolutePath: string, content: string) => Promise<void>;
}

const defaultOperations: WriteOperations = {
  fileExists,
  readTextFile,
  writeTextFile
};

export interface WriteToolOptions {
  operations?: WriteOperations;
}

export function createWriteToolDefinition(cwd: string, options?: WriteToolOptions): ToolDefinition<ToolCallByName<"write">> {
  const ops = options?.operations ?? defaultOperations;
  return {
    name: "write",
    description: "Create or overwrite files.",
    promptSnippet: "Create or overwrite files",
    promptGuidelines: ["Use write only for new files or complete rewrites."],
    async execute(call: ToolCallByName<"write">, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
      const absolutePath = resolveWorkspacePath(cwd, call.path);
      const before = (await ops.fileExists(absolutePath)) ? await ops.readTextFile(absolutePath) : "";
      await ops.writeTextFile(absolutePath, call.content);

      return {
        action: `WRITE(${call.path})`,
        displayLines: [`  L WROTE ${call.path} (${call.content.length} chars)`, ...renderDiff(before, call.content)],
        report: `write ${call.path} (${call.content.length} chars)`,
        mutationSuccessCount: 1
      };
    }
  };
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): ToolDefinition<ToolCallByName<"write">> {
  return createWriteToolDefinition(cwd, options);
}
