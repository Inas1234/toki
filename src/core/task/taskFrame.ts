import { TaskFrame } from "../types.js";

const PATH_PATTERN = /(?:[A-Za-z]:)?(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+/g;
const SYMBOL_PATTERN = /\b[A-Z][A-Za-z0-9_]+\b/g;
const ERROR_PATTERN = /\b(?:error|exception|traceback|failed|failing)\b.*$/gim;

const DOMAIN_KEYWORDS = [
  "api",
  "database",
  "ui",
  "frontend",
  "backend",
  "cli",
  "test",
  "build",
  "deploy",
  "auth",
  "security",
  "performance"
];

function detectIntent(raw: string): string {
  const value = raw.toLowerCase();
  if (/\b(fix|bug|error|fail)\b/.test(value)) {
    return "debug_and_fix";
  }
  if (/\b(test|coverage|assert)\b/.test(value)) {
    return "test_work";
  }
  if (/\b(refactor|cleanup|restructure)\b/.test(value)) {
    return "refactor";
  }
  if (/\b(build|create|implement|add)\b/.test(value)) {
    return "implement_feature";
  }
  return "general_assistance";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function buildTaskFrame(raw: string): TaskFrame {
  const intent = detectIntent(raw);
  const lower = raw.toLowerCase();

  const paths = unique([...(raw.match(PATH_PATTERN) ?? [])]);
  const symbols = unique([...(raw.match(SYMBOL_PATTERN) ?? [])]).slice(0, 40);
  const errors = unique([...(raw.match(ERROR_PATTERN) ?? [])]);
  const domains = DOMAIN_KEYWORDS.filter((keyword) => lower.includes(keyword));

  const risk =
    /\b(migration|security|payment|prod|production|data loss|critical)\b/.test(lower)
      ? "high"
      : /\b(auth|deploy|database|infra)\b/.test(lower)
        ? "medium"
        : "low";

  const needsEdit = /\b(edit|change|modify|create|build|implement|fix|refactor)\b/.test(lower);
  const needsTests = /\b(tests?|spec|coverage|assert|verify)\b/.test(lower) || risk !== "low";

  let confidence = 0.5;
  if (paths.length > 0) confidence += 0.15;
  if (symbols.length > 0) confidence += 0.15;
  if (domains.length > 0) confidence += 0.1;
  if (errors.length > 0) confidence += 0.1;

  return {
    raw,
    intent,
    entities: {
      paths,
      symbols,
      errors,
      domains
    },
    risk,
    needsEdit,
    needsTests,
    confidence: Math.min(confidence, 0.95)
  };
}
