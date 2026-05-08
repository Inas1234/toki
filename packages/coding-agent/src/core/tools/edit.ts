import { fileExists, readTextFile, writeTextFile } from "@toki/shared";
import type { ToolCallByName, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { renderDiff, resolveWorkspacePath } from "./helpers.js";

export interface EditOperations {
  fileExists: (absolutePath: string) => Promise<boolean>;
  readTextFile: (absolutePath: string) => Promise<string>;
  writeTextFile: (absolutePath: string, content: string) => Promise<void>;
}

const defaultOperations: EditOperations = {
  fileExists,
  readTextFile,
  writeTextFile
};

export interface EditToolOptions {
  operations?: EditOperations;
}

interface PositionedEdit {
  start: number;
  end: number;
  newText: string;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function restoreLineEndings(value: string, template: string): string {
  return template.includes("\r\n") ? value.replace(/\n/g, "\r\n") : value;
}

function locateEdits(original: string, edits: ToolCallByName<"edit">["edits"]): PositionedEdit[] {
  const positioned: PositionedEdit[] = [];

  for (const edit of edits) {
    const oldText = normalizeLineEndings(edit.oldText);
    const newText = normalizeLineEndings(edit.newText);
    const start = original.indexOf(oldText);
    if (start < 0) {
      throw new Error("find text not present. retry with exact text from file.");
    }
    const duplicate = original.indexOf(oldText, start + 1);
    if (duplicate >= 0) {
      throw new Error("edit oldText must be unique in file.");
    }
    positioned.push({ start, end: start + oldText.length, newText });
  }

  positioned.sort((left, right) => left.start - right.start);
  for (let index = 1; index < positioned.length; index += 1) {
    if (positioned[index - 1]!.end > positioned[index]!.start) {
      throw new Error("edit blocks overlap. merge them into one edit.");
    }
  }

  return positioned;
}

function applyEdits(original: string, edits: ToolCallByName<"edit">["edits"]): string {
  const normalizedOriginal = normalizeLineEndings(original);
  const positioned = locateEdits(normalizedOriginal, edits);
  let updated = normalizedOriginal;

  for (let index = positioned.length - 1; index >= 0; index -= 1) {
    const edit = positioned[index]!;
    updated = `${updated.slice(0, edit.start)}${edit.newText}${updated.slice(edit.end)}`;
  }

  return restoreLineEndings(updated, original);
}

export function createEditToolDefinition(cwd: string, options?: EditToolOptions): ToolDefinition<ToolCallByName<"edit">> {
  const ops = options?.operations ?? defaultOperations;
  return {
    name: "edit",
    description: "Make precise file edits with exact text replacement.",
    promptSnippet: "Make precise file edits with exact text replacement",
    promptGuidelines: [
      "Use edit for precise changes (edits[].oldText must match exactly).",
      "When changing multiple separate locations in one file, prefer a single edit call with multiple edits[]."
    ],
    async execute(call: ToolCallByName<"edit">, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
      if (call.edits.length === 0) {
        throw new Error("edit requires at least one replacement");
      }
      const absolutePath = resolveWorkspacePath(cwd, call.path);
      if (!(await ops.fileExists(absolutePath))) {
        throw new Error("target file does not exist");
      }
      const before = await ops.readTextFile(absolutePath);
      const after = applyEdits(before, call.edits);
      await ops.writeTextFile(absolutePath, after);

      return {
        action: `EDIT(${call.path})`,
        displayLines: [`  L UPDATED ${call.path}`, ...renderDiff(before, after)],
        report: `edit ${call.path} (${call.edits.length} block(s))`,
        mutationSuccessCount: 1
      };
    }
  };
}

export function createEditTool(cwd: string, options?: EditToolOptions): ToolDefinition<ToolCallByName<"edit">> {
  return createEditToolDefinition(cwd, options);
}
