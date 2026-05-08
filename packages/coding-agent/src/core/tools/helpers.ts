import path from "node:path";

export function resolveWorkspacePath(repoDir: string, rawPath: string): string {
  const root = path.resolve(repoDir);
  const target = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(root, rawPath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path outside workspace is not allowed: ${rawPath}`);
  }
  return target;
}

export function relativeToRepo(repoDir: string, absolutePath: string): string {
  return path.relative(path.resolve(repoDir), absolutePath).replace(/\\/g, "/");
}

export function clampLimit(value: number | undefined, maxLimit: number, fallback: number): number {
  const base = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, Math.min(maxLimit, base));
}

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

export function summarizeInline(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, maxChars - 3)}...`;
}

export function renderDiff(before: string, after: string, maxPreview = 80): string[] {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const out: string[] = [];
  let unchangedPrefix = 0;
  while (
    unchangedPrefix < beforeLines.length &&
    unchangedPrefix < afterLines.length &&
    beforeLines[unchangedPrefix] === afterLines[unchangedPrefix]
  ) {
    unchangedPrefix += 1;
  }

  let unchangedSuffix = 0;
  while (
    unchangedSuffix < beforeLines.length - unchangedPrefix &&
    unchangedSuffix < afterLines.length - unchangedPrefix &&
    beforeLines[beforeLines.length - 1 - unchangedSuffix] === afterLines[afterLines.length - 1 - unchangedSuffix]
  ) {
    unchangedSuffix += 1;
  }

  const removed = beforeLines.slice(unchangedPrefix, beforeLines.length - unchangedSuffix);
  const added = afterLines.slice(unchangedPrefix, afterLines.length - unchangedSuffix);
  if (removed.length === 0 && added.length === 0) {
    return out;
  }

  out.push("  L @@ diff @@");
  for (const line of removed.slice(0, maxPreview)) {
    out.push(`  - ${line}`);
  }
  for (const line of added.slice(0, maxPreview)) {
    out.push(`  + ${line}`);
  }
  if (removed.length > maxPreview || added.length > maxPreview) {
    out.push(`  L ... diff truncated to ${maxPreview} line(s) per side`);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExp(char);
  }
  source += "$";
  return new RegExp(source);
}
