import { TaskFrame } from "@toki/shared";

const PATH_PATTERN = /(?:[A-Za-z]:)?(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+/g;
const ERROR_PATTERN = /\b(?:error|exception|traceback|failed|failing)\b.*$/gim;
const QUESTION_PREFIX_PATTERN =
  /^(?:what|why|how|when|where|who|which|can|could|would|should|is|are|do|does|did)\b/;
const EDIT_VERB_PATTERN =
  /\b(edit|change|modify|create|build|implement|fix|refactor|update|rewrite|remove|delete|rename|patch|adjust|improve|add)\b/;
const EXPLAIN_ONLY_PATTERN =
  /\b(explain|describe|summari[sz]e|walk me through|tell me|what is|how does)\b/;

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
  "performance",
  "engine",
  "tool",
  "context",
  "broker",
  "orchestrator"
];

const TOOL_TRANSCRIPT_LINE_PATTERN =
  /^(?:\s*(?:READ|SEARCH|LIST|WRITE|APPEND|UPDATE|RUN|TOOLING)\([^)]*\)|\s*[│╭╰─]+\s*|\s*L\s+.*|\s*\*?\s+L\s+.*)$/i;

function sanitizeForEntityExtraction(raw: string): string {
  return raw
    .split(/\r?\n/)
    .filter((line) => !TOOL_TRANSCRIPT_LINE_PATTERN.test(line))
    .join("\n");
}

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
  if (/\b(build|create|implement|add|update|change|modify|write|rename|remove|delete|patch)\b/.test(value)) {
    return "implement_feature";
  }
  return "general_assistance";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function extractSymbols(raw: string): string[] {
  const matches: string[] = [];
  const codeSpanPattern = /`([^`\r\n]+)`/g;
  for (const match of raw.matchAll(codeSpanPattern)) {
    const value = match[1]?.trim();
    if (value && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) {
      matches.push(value);
    }
  }

  const codeLikePattern =
    /\b(?:[A-Z]{2,}[A-Za-z0-9_]*|[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]+)\b/g;
  for (const match of raw.matchAll(codeLikePattern)) {
    if (match[0]) {
      matches.push(match[0]);
    }
  }

  return unique(matches).slice(0, 40);
}

export function buildTaskFrame(raw: string): TaskFrame {
  const intent = detectIntent(raw);
  const lower = raw.toLowerCase();
  const trimmed = raw.trim();
  const extractionSource = sanitizeForEntityExtraction(raw);
  const extractionLower = extractionSource.toLowerCase();

  const paths = unique([...(extractionSource.match(PATH_PATTERN) ?? [])]);
  const symbols = extractSymbols(extractionSource);
  const errors = unique([...(extractionSource.match(ERROR_PATTERN) ?? [])]);
  const domains = DOMAIN_KEYWORDS.filter((keyword) => extractionLower.includes(keyword));
  if (/\b(agent|tooling|tool call|tool calls|search the codebase|search codebase|context broker)\b/.test(extractionLower)) {
    domains.push("engine", "tool", "context", "broker", "orchestrator");
  }

  const risk =
    /\b(migration|security|payment|prod|production|data loss|critical)\b/.test(lower)
      ? "high"
      : /\b(auth|deploy|database|infra)\b/.test(lower)
        ? "medium"
        : "low";

  const looksLikeQuestion = trimmed.endsWith("?") || QUESTION_PREFIX_PATTERN.test(lower);
  const mentionsEditAction = EDIT_VERB_PATTERN.test(lower);
  const intentImpliesEdit = intent === "debug_and_fix" || intent === "refactor" || intent === "implement_feature";
  const explainOnly = EXPLAIN_ONLY_PATTERN.test(lower) && !mentionsEditAction;
  const needsEdit = (mentionsEditAction || (intentImpliesEdit && !looksLikeQuestion)) && !explainOnly;
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
      domains: unique(domains)
    },
    risk,
    needsEdit,
    needsTests,
    confidence: Math.min(confidence, 0.95)
  };
}
