import { z } from "zod";

export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

export interface EditReplacement {
  oldText: string;
  newText: string;
}

interface BaseToolCall {
  tool: ToolName;
  path?: string;
}

export type ToolCall =
  | (BaseToolCall & { tool: "read"; path: string; offset?: number; limit?: number })
  | (BaseToolCall & { tool: "bash"; command: string; timeout?: number })
  | (BaseToolCall & { tool: "edit"; path: string; edits: EditReplacement[] })
  | (BaseToolCall & { tool: "write"; path: string; content: string })
  | (BaseToolCall & {
      tool: "grep";
      pattern: string;
      glob?: string;
      ignoreCase?: boolean;
      literal?: boolean;
      context?: number;
      limit?: number;
    })
  | (BaseToolCall & { tool: "find"; pattern: string; limit?: number })
  | (BaseToolCall & { tool: "ls"; limit?: number });

const TOOL_NAME_MAP: Record<string, ToolName> = {
  read: "read",
  read_file: "read",
  readfile: "read",
  file_read: "read",
  bash: "bash",
  shell: "bash",
  sh: "bash",
  command: "bash",
  run: "bash",
  run_command: "bash",
  runcommand: "bash",
  exec: "bash",
  execute: "bash",
  edit: "edit",
  replace_in_file: "edit",
  replaceinfile: "edit",
  edit_file: "edit",
  update_file: "edit",
  write: "write",
  write_file: "write",
  writefile: "write",
  create_file: "write",
  grep: "grep",
  search: "grep",
  search_files: "grep",
  searchfiles: "grep",
  find_in_files: "grep",
  find: "find",
  ls: "ls",
  list: "ls",
  list_files: "ls",
  listfiles: "ls"
};

const editReplacementSchema = z.object({
  oldText: z.string(),
  newText: z.string()
});

const toolCallSchema = z
  .object({
    tool: z.enum(["read", "bash", "edit", "write", "grep", "find", "ls"]),
    path: z.string().optional(),
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
    command: z.string().optional(),
    timeout: z.number().positive().optional(),
    edits: z.array(editReplacementSchema).optional(),
    content: z.string().optional(),
    pattern: z.string().optional(),
    glob: z.string().optional(),
    ignoreCase: z.boolean().optional(),
    literal: z.boolean().optional(),
    context: z.number().int().min(0).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.tool === "read" && !value.path) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "read requires path" });
    }
    if (value.tool === "bash" && (typeof value.command !== "string" || value.command.trim().length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "bash requires command" });
    }
    if (value.tool === "edit") {
      if (!value.path) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "edit requires path" });
      }
      if (!Array.isArray(value.edits) || value.edits.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "edit requires edits" });
      }
    }
    if (value.tool === "write" && (!value.path || typeof value.content !== "string")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "write requires path and content" });
    }
    if ((value.tool === "grep" || value.tool === "find") && (typeof value.pattern !== "string" || value.pattern.trim().length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${value.tool} requires pattern` });
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

function parseJsonArrayString(value: unknown): unknown[] | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed : null;
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

function toBooleanValue(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") {
        return true;
      }
      if (normalized === "false") {
        return false;
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

function parseEditEntries(direct: Record<string, unknown>): EditReplacement[] {
  const explicitEdits = Array.isArray(direct.edits) ? direct.edits : parseJsonArrayString(direct.edits) ?? [];
  const edits: EditReplacement[] = [];

  for (const entry of explicitEdits) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    const replacement = editReplacementSchema.safeParse({
      oldText: toStringValue(record.oldText, record.old_text, record.find, record.search_text),
      newText: toStringValue(record.newText, record.new_text, record.replace, record.replace_text)
    });
    if (replacement.success) {
      edits.push(replacement.data);
    }
  }

  if (edits.length > 0) {
    return edits;
  }

  const oldText = toStringValue(direct.oldText, direct.old_text, direct.find, direct.search_text);
  const newText = toStringValue(direct.newText, direct.new_text, direct.replace, direct.replace_text);
  if (typeof oldText === "string" && typeof newText === "string") {
    return [{ oldText, newText }];
  }
  return [];
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

  if (tool === "edit") {
    const candidate = {
      tool,
      path: toStringValue(direct.path, direct.file, direct.filepath, direct.file_path),
      edits: parseEditEntries(direct)
    };
    const parsed = toolCallSchema.safeParse(candidate);
    return parsed.success ? [parsed.data as ToolCall] : [];
  }

  if (tool === "read") {
    const offset = toIntValue(direct.offset, direct.start_line, direct.startLine, direct.line_start);
    const explicitLimit = toIntValue(direct.limit);
    const endLine = toIntValue(direct.end_line, direct.endLine, direct.line_end);
    const limit =
      explicitLimit ?? (typeof offset === "number" && typeof endLine === "number" ? endLine - offset + 1 : undefined);
    const candidate = {
      tool,
      path: toStringValue(direct.path, direct.file, direct.filepath, direct.file_path),
      offset,
      limit
    };
    const parsed = toolCallSchema.safeParse(candidate);
    return parsed.success ? [parsed.data as ToolCall] : [];
  }

  if (tool === "write") {
    const candidate = {
      tool,
      path: toStringValue(direct.path, direct.file, direct.filepath, direct.file_path),
      content: toStringValue(direct.content, direct.text)
    };
    const parsed = toolCallSchema.safeParse(candidate);
    return parsed.success ? [parsed.data as ToolCall] : [];
  }

  if (tool === "bash") {
    const timeoutSeconds =
      toIntValue(direct.timeout) ??
      (() => {
        const timeoutMs = toIntValue(direct.timeout_ms, direct.timeoutMs);
        return typeof timeoutMs === "number" ? Math.max(1, Math.ceil(timeoutMs / 1000)) : undefined;
      })();

    const candidate = {
      tool,
      command: toStringValue(direct.command, direct.cmd),
      timeout: timeoutSeconds
    };
    const parsed = toolCallSchema.safeParse(candidate);
    return parsed.success ? [parsed.data as ToolCall] : [];
  }

  if (tool === "grep") {
    const candidate = {
      tool,
      path: toStringValue(direct.path, direct.file, direct.filepath, direct.file_path),
      pattern: toStringValue(direct.pattern, direct.query, direct.search),
      glob: toStringValue(direct.glob),
      ignoreCase: toBooleanValue(direct.ignoreCase, direct.ignore_case),
      literal: toBooleanValue(direct.literal),
      context: toIntValue(direct.context),
      limit: toIntValue(direct.limit, direct.max_results, direct.maxResults)
    };
    const parsed = toolCallSchema.safeParse(candidate);
    return parsed.success ? [parsed.data as ToolCall] : [];
  }

  if (tool === "find") {
    const candidate = {
      tool,
      path: toStringValue(direct.path, direct.file, direct.filepath, direct.file_path),
      pattern: toStringValue(direct.pattern, direct.query, direct.search),
      limit: toIntValue(direct.limit, direct.max_results, direct.maxResults)
    };
    const parsed = toolCallSchema.safeParse(candidate);
    return parsed.success ? [parsed.data as ToolCall] : [];
  }

  const candidate = {
    tool,
    path: toStringValue(direct.path, direct.file, direct.filepath, direct.file_path),
    limit: toIntValue(direct.limit, direct.max_results, direct.maxResults)
  };
  const parsed = toolCallSchema.safeParse(candidate);
  return parsed.success ? [parsed.data as ToolCall] : [];
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
