import { TaskFrame } from "@toki/shared";

const PATH_PATTERN = /(?:[A-Za-z]:)?(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+/g;
const ERROR_PATTERN = /\b(?:error|exception|traceback|failed|failing)\b.*$/gim;
const QUESTION_PREFIX_PATTERN =
  /^(?:what|why|how|when|where|who|which|can|could|would|should|is|are|do|does|did)\b/;
const EDIT_VERB_PATTERN =
  /\b(edit|change|modify|create|build|implement|fix|refactor|update|rewrite|remove|delete|rename|patch|adjust|improve|add)\b/;
const EXPLAIN_ONLY_PATTERN =
  /\b(explain|describe|summari[sz]e|walk me through|tell me|what is|how does)\b/;
const REQUEST_SIGNAL_PATTERN =
  /\b(why|how|what|fix|implement|debug|broken|fails?|failing|happening|context|understand|agent|tool|model)\b/;

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
  /^\s*(?:READ|SEARCH|LIST|WRITE|APPEND|UPDATE|RUN|TOOLING|EDIT|BASH)\([^)]*\)\s*$/i;
const TRANSCRIPT_STATUS_LINE_PATTERN = /^\s*(?:\*?\s+)?L\s+.+$/i;
const SHELL_OUTPUT_LINE_PATTERN = /^\s*\|\s.+$/;
const DIFF_HEADER_PATTERN = /^\s*(?:---|\+\+\+|@@)\b/;
const CODE_FENCE_PATTERN = /^\s*```/;
const LANGUAGE_LABEL_PATTERN = /^\s*(?:bash|sh|zsh|powershell|pwsh|toml|json|yaml|yml|ts|tsx|js|jsx|md|markdown|code)\s*$/i;
const TRANSCRIPT_NARRATION_PATTERN =
  /^\s*(?:i['’]ll\s+\w+|looking at\b|edit\s+\S+\s+with:|install dependencies|build all packages|run the cli in development mode)\b/i;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isLikelyPath(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, "/").trim();
  if (normalized.length === 0 || /\s/.test(normalized)) {
    return false;
  }

  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return false;
  }

  const first = segments[0] ?? "";
  const last = segments[segments.length - 1] ?? "";
  const hasDriveRoot = /^[A-Za-z]:$/.test(first);
  const hasExtension = /\.[A-Za-z0-9]+$/.test(last);
  const looksLikeWorkspaceRoot =
    /^(?:src|tests?|packages|apps|lib|docs|dist|build|scripts|config|\.[A-Za-z0-9_-]+)$/i.test(first) || hasDriveRoot;
  const looksLikeSingleFile =
    /^(?:README(?:\.[A-Za-z0-9]+)?|package\.json|tsconfig(?:\..+)?\.json|vite\.config\.[A-Za-z0-9]+|vitest\.config\.[A-Za-z0-9]+)$/i.test(
      normalized
    );

  if (looksLikeSingleFile) {
    return true;
  }

  if (segments.length === 2 && /^(?:a|b)$/i.test(first) && hasExtension) {
    return false;
  }

  if (!hasExtension && !looksLikeWorkspaceRoot) {
    return false;
  }

  if (!looksLikeWorkspaceRoot && segments.length < 3) {
    return false;
  }

  return true;
}

function extractPaths(raw: string): string[] {
  return unique([...(raw.match(PATH_PATTERN) ?? [])].filter(isLikelyPath));
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

function scoreObjectiveParagraph(paragraph: string, index: number, total: number): number {
  const lower = paragraph.toLowerCase();
  let score = 0;

  if (REQUEST_SIGNAL_PATTERN.test(lower)) {
    score += 5;
  }
  if (EDIT_VERB_PATTERN.test(lower)) {
    score += 4;
  }
  if (paragraph.includes("?")) {
    score += 3;
  }
  if (/\b(i|me|my|mine|you)\b/.test(lower)) {
    score += 2;
  }
  if (index >= total - 2) {
    score += 3;
  }
  if (index === total - 1) {
    score += 2;
  }
  if (TRANSCRIPT_NARRATION_PATTERN.test(lower)) {
    score -= 8;
  }
  if (/\b(?:readme\.md|package\.json|tooling\(\)|read\(|edit\(|@@)\b/i.test(paragraph)) {
    score -= 8;
  }

  const pathMatches = paragraph.match(PATH_PATTERN) ?? [];
  score -= Math.min(pathMatches.length * 2, 8);

  if (/[<>{}\[\];]/.test(paragraph)) {
    score -= 2;
  }
  if (paragraph.trim().length < 8) {
    score -= 2;
  }

  return score;
}

function isLikelyActionFollowup(paragraph: string): boolean {
  const trimmed = paragraph.trim();
  return trimmed.length > 0 && trimmed.length <= 80 && EDIT_VERB_PATTERN.test(trimmed.toLowerCase());
}

function deriveTaskObjective(raw: string, cleaned: string): string {
  const paragraphs = cleaned
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/[ \t]+/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0);

  if (paragraphs.length === 0) {
    return raw.replace(/\s+/g, " ").trim();
  }

  const scored = paragraphs.map((paragraph, index) => ({
    paragraph,
    index,
    score: scoreObjectiveParagraph(paragraph, index, paragraphs.length)
  }));
  const trailingRelevant = scored.slice(-3).filter((entry) => entry.score >= 3);
  if (trailingRelevant.length > 0) {
    return trailingRelevant.map((entry) => entry.paragraph).join("\n");
  }

  const best = [...scored].sort((left, right) => right.score - left.score || right.index - left.index)[0];
  if (!best) {
    return cleaned.replace(/\s+/g, " ").trim();
  }

  const chosen = [best.paragraph];
  const next = paragraphs[best.index + 1];
  if (next && isLikelyActionFollowup(next)) {
    chosen.push(next);
  }

  return chosen.join("\n");
}

export function stripToolTranscriptNoise(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  let inFence = false;
  let inDiff = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (CODE_FENCE_PATTERN.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }

    if (trimmed.includes("@@ diff @@") || DIFF_HEADER_PATTERN.test(trimmed)) {
      inDiff = true;
      continue;
    }
    if (inDiff) {
      if (trimmed.length === 0) {
        inDiff = false;
      }
      continue;
    }

    if (trimmed.length === 0) {
      kept.push("");
      continue;
    }
    if (
      TOOL_TRANSCRIPT_LINE_PATTERN.test(trimmed) ||
      TRANSCRIPT_STATUS_LINE_PATTERN.test(trimmed) ||
      SHELL_OUTPUT_LINE_PATTERN.test(trimmed) ||
      /^\s*context:\s/i.test(trimmed) ||
      /^\s*cwd:\s/i.test(trimmed) ||
      /^\s*stdout:\s/i.test(trimmed) ||
      /^\s*stderr:\s/i.test(trimmed) ||
      /[\u2500-\u257F]/.test(trimmed) ||
      LANGUAGE_LABEL_PATTERN.test(trimmed) ||
      TRANSCRIPT_NARRATION_PATTERN.test(trimmed)
    ) {
      continue;
    }

    kept.push(line.trimEnd());
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function buildTaskFrame(raw: string): TaskFrame {
  const extractionSource = stripToolTranscriptNoise(raw);
  const objective = deriveTaskObjective(raw, extractionSource);
  const intent = detectIntent(objective);
  const lower = objective.toLowerCase();
  const extractionLower = extractionSource.toLowerCase();
  const trimmed = objective.trim();

  const paths = extractPaths(extractionSource);
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
    objective,
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
