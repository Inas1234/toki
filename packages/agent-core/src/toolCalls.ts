import { z } from "zod";

export type ToolName =
  | "read_file"
  | "list_files"
  | "search_files"
  | "write_file"
  | "append_file"
  | "replace_in_file"
  | "run_command";

export interface ToolCall {
  tool: ToolName;
  path?: string | undefined;
  content?: string | undefined;
  find?: string | undefined;
  replace?: string | undefined;
  query?: string | undefined;
  max_results?: number | undefined;
  start_line?: number | undefined;
  end_line?: number | undefined;
  command?: string | undefined;
  cwd?: string | undefined;
  timeout_ms?: number | undefined;
}

const TOOL_NAME_MAP: Record<string, ToolName> = {
  read: "read_file",
  read_file: "read_file",
  readfile: "read_file",
  file_read: "read_file",
  list: "list_files",
  list_files: "list_files",
  listfiles: "list_files",
  ls_files: "list_files",
  search: "search_files",
  search_files: "search_files",
  searchfiles: "search_files",
  grep: "search_files",
  find_in_files: "search_files",
  write: "write_file",
  write_file: "write_file",
  writefile: "write_file",
  create_file: "write_file",
  append: "append_file",
  append_file: "append_file",
  appendfile: "append_file",
  edit: "replace_in_file",
  replace: "replace_in_file",
  replace_in_file: "replace_in_file",
  replaceinfile: "replace_in_file",
  edit_file: "replace_in_file",
  update_file: "replace_in_file",
  shell: "run_command",
  sh: "run_command",
  command: "run_command",
  run: "run_command",
  run_command: "run_command",
  runcommand: "run_command",
  exec: "run_command",
  execute: "run_command",
  exec_command: "run_command",
  execute_command: "run_command"
};

const toolCallSchema = z
  .object({
    tool: z.enum(["read_file", "list_files", "search_files", "write_file", "append_file", "replace_in_file", "run_command"]),
    path: z.string().optional(),
    content: z.string().optional(),
    find: z.string().optional(),
    replace: z.string().optional(),
    query: z.string().optional(),
    max_results: z.number().int().positive().optional(),
    start_line: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
    command: z.string().optional(),
    cwd: z.string().optional(),
    timeout_ms: z.number().int().positive().optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.tool === "write_file" || value.tool === "append_file" || value.tool === "replace_in_file") && !value.path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.tool} requires path`
      });
    }
    if ((value.tool === "write_file" || value.tool === "append_file") && typeof value.content !== "string") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.tool} requires content`
      });
    }
    if (value.tool === "replace_in_file" && (typeof value.find !== "string" || typeof value.replace !== "string")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "replace_in_file requires find and replace"
      });
    }
    if (value.tool === "search_files" && (typeof value.query !== "string" || value.query.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "search_files requires query"
      });
    }
    if (value.tool === "run_command" && (typeof value.command !== "string" || value.command.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "run_command requires command"
      });
    }
    if (typeof value.start_line === "number" && typeof value.end_line === "number" && value.start_line > value.end_line) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "start_line must be <= end_line"
      });
    }
  });

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseJsonObjectString(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function toStringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function toIntValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.trunc(value);
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function canonicalToolName(value: unknown): ToolName | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return TOOL_NAME_MAP[normalized] ?? null;
}

function normalizeToolToken(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function extractSegmentBodies(text: string): string[] {
  const out: string[] = [];

  const wrapped = [...text.matchAll(/<tool_calls>\s*([\s\S]*?)\s*<\/tool_calls>/gi)];
  for (const match of wrapped) {
    if (match[1]) {
      out.push(match[1]);
    }
  }

  const singleBlocks = [...text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)];
  for (const match of singleBlocks) {
    if (match[1]) {
      out.push(match[1]);
    }
  }

  const bracketedBlocks = [...text.matchAll(/\[tool_calls?\]\s*([\s\S]*?)\s*\[\/tool_calls?\]/gi)];
  for (const match of bracketedBlocks) {
    if (match[1]) {
      out.push(match[1]);
    }
  }

  if (out.length === 0) {
    out.push(text);
  }
  return out;
}

function quoteBareObjectKeys(value: string): string {
  return value.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
}

function normalizeStringQuotes(value: string): string {
  return value.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, inner: string) => `"${inner.replace(/"/g, '\\"')}"`);
}

function removeTrailingCommas(value: string): string {
  return value.replace(/,(\s*[}\]])/g, "$1");
}

function normalizeJsonLikeValue(value: string): string {
  return removeTrailingCommas(normalizeStringQuotes(quoteBareObjectKeys(value)));
}

function splitJsonLikeObjectSequence(text: string): string[] {
  const blocks: string[] = [];
  let index = 0;

  while (index < text.length) {
    while (index < text.length && /[\s,]/.test(text[index]!)) {
      index += 1;
    }
    if (index >= text.length) {
      break;
    }
    if (text[index] !== "{") {
      return [];
    }
    const block = readBalancedJson(text, index);
    if (!block) {
      return [];
    }
    blocks.push(block);
    index += block.length;
  }

  return blocks;
}

function parseJsonCandidate(candidate: string): unknown | null {
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    const normalized = normalizeJsonLikeValue(candidate);
    try {
      return JSON.parse(normalized) as unknown;
    } catch {
      const objectBlocks = splitJsonLikeObjectSequence(candidate);
      if (objectBlocks.length === 0) {
        return null;
      }
      const wrapped = `[${objectBlocks.map((block) => normalizeJsonLikeValue(block)).join(",")}]`;
      try {
        return JSON.parse(wrapped) as unknown;
      } catch {
        return null;
      }
    }
  }
}

function normalizeToolJson(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  if (candidate.startsWith("[") || candidate.startsWith("{")) {
    return candidate;
  }
  const embeddedJson = candidate.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (embeddedJson?.[1]) {
    return embeddedJson[1].trim();
  }
  return null;
}

function readBalancedJson(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
      if (depth < 0) {
        return null;
      }
    }
  }
  return null;
}

function extractJsonCandidates(raw: string): string[] {
  const out: string[] = [];
  const normalized = normalizeToolJson(raw);
  if (normalized) {
    out.push(normalized);
  }

  const text = raw.trim();
  const starts: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{" || ch === "[") {
      starts.push(i);
    }
  }

  for (const start of starts) {
    const candidate = readBalancedJson(text, start);
    if (candidate && !out.includes(candidate)) {
      out.push(candidate);
    }
    if (out.length >= 48) {
      break;
    }
  }

  return out;
}

function flattenRoot(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  const objectValue = asRecord(value);
  if (!objectValue) {
    return [];
  }
  if (Array.isArray(objectValue.tool_calls)) {
    return objectValue.tool_calls;
  }
  if (Array.isArray(objectValue.calls)) {
    return objectValue.calls;
  }
  return [objectValue];
}

function normalizeEditToolCalls(pathValue: string | undefined, direct: Record<string, unknown>): ToolCall[] {
  if (!pathValue) {
    return [];
  }

  const editsRaw = Array.isArray(direct.edits) ? direct.edits : [];
  const legacyOldText = toStringValue(direct.oldText, direct.old_text, direct.find, direct.search_text);
  const legacyNewText = toStringValue(direct.newText, direct.new_text, direct.replace, direct.replace_text);
  const collected: ToolCall[] = [];

  for (const entry of editsRaw) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    const candidate: ToolCall = {
      tool: "replace_in_file",
      path: pathValue,
      find: toStringValue(record.oldText, record.old_text, record.find, record.search_text),
      replace: toStringValue(record.newText, record.new_text, record.replace, record.replace_text)
    };
    const parsed = toolCallSchema.safeParse(candidate);
    if (parsed.success) {
      collected.push(parsed.data);
    }
  }

  if (collected.length > 0) {
    return collected;
  }

  const legacyCandidate: ToolCall = {
    tool: "replace_in_file",
    path: pathValue,
    find: legacyOldText,
    replace: legacyNewText
  };
  const parsed = toolCallSchema.safeParse(legacyCandidate);
  return parsed.success ? [parsed.data] : [];
}

function normalizeRawCall(raw: unknown): ToolCall[] {
  const root = asRecord(raw);
  if (!root) {
    return [];
  }

  const fnRecord = asRecord(root.function);
  const nestedArgs =
    parseJsonObjectString(root.arguments) ??
    asRecord(root.arguments) ??
    parseJsonObjectString(root.args) ??
    asRecord(root.args) ??
    parseJsonObjectString(root.input) ??
    asRecord(root.input) ??
    parseJsonObjectString(root.parameters) ??
    asRecord(root.parameters) ??
    parseJsonObjectString(fnRecord?.arguments) ??
    asRecord(fnRecord?.arguments) ??
    parseJsonObjectString(fnRecord?.args) ??
    asRecord(fnRecord?.args) ??
    parseJsonObjectString(fnRecord?.input) ??
    asRecord(fnRecord?.input) ??
    parseJsonObjectString(fnRecord?.parameters) ??
    asRecord(fnRecord?.parameters) ??
    {};

  const direct = {
    ...nestedArgs,
    ...root,
    ...(fnRecord ?? {})
  };

  const rawToolName = root.tool ?? root.name ?? fnRecord?.name;
  const tool = canonicalToolName(rawToolName);
  if (!tool) {
    return [];
  }

  const pathValue = toStringValue(direct.path, direct.file, direct.filepath, direct.file_path);
  const toolToken = normalizeToolToken(rawToolName);
  if (tool === "replace_in_file" && (toolToken === "edit" || Array.isArray(direct.edits) || direct.oldText !== undefined)) {
    return normalizeEditToolCalls(pathValue, direct);
  }

  const startLine = toIntValue(direct.start_line, direct.startLine, direct.line_start, direct.offset);
  const limit = toIntValue(direct.limit);
  const explicitEndLine = toIntValue(direct.end_line, direct.endLine, direct.line_end);
  const endLine =
    explicitEndLine ?? (typeof startLine === "number" && typeof limit === "number" ? startLine + limit - 1 : undefined);

  const normalized: ToolCall = {
    tool,
    path: pathValue,
    content: toStringValue(direct.content, direct.text),
    find: toStringValue(direct.find, direct.old, direct.search_text),
    replace: toStringValue(direct.replace, direct.new, direct.replacement, direct.replace_text),
    query: toStringValue(direct.query, direct.search, direct.pattern),
    max_results: toIntValue(direct.max_results, direct.maxResults),
    start_line: startLine,
    end_line: endLine,
    command: toStringValue(direct.command, direct.cmd),
    cwd: toStringValue(direct.cwd, direct.working_dir, direct.workdir),
    timeout_ms: toIntValue(direct.timeout_ms, direct.timeoutMs, direct.timeout)
  };

  const parsed = toolCallSchema.safeParse(normalized);
  if (!parsed.success) {
    return [];
  }
  return [parsed.data];
}

export function parseToolCallsFromText(text: string): ToolCall[] {
  const valid: ToolCall[] = [];
  const seen = new Set<string>();
  const segments = extractSegmentBodies(text);

  for (const segment of segments) {
    const candidates = extractJsonCandidates(segment);
    for (const candidate of candidates) {
      const parsedRoot = parseJsonCandidate(candidate);
      if (parsedRoot === null) {
        continue;
      }

      const flat = flattenRoot(parsedRoot);
      for (const entry of flat) {
        const normalizedCalls = normalizeRawCall(entry);
        for (const normalized of normalizedCalls) {
          const hash = JSON.stringify(normalized);
          if (seen.has(hash)) {
            continue;
          }
          seen.add(hash);
          valid.push(normalized);
          if (valid.length >= 16) {
            return valid;
          }
        }
      }
    }
  }

  return valid;
}
