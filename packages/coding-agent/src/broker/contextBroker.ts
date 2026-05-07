import path from "node:path";
import {
  BudgetMode,
  CachedSummary,
  ContextItem,
  ContextReceipt,
  FileRepresentation,
  GlobalConfig,
  SymbolIndexEntry,
  TaskFrame,
  estimateTokens,
  extractStaticData,
  takeSnippet
} from "@toki/shared";
import { modeToCeiling } from "../config.js";
import { ContextGraph } from "../graph/contextGraph.js";

interface BrokerSelection {
  items: ContextItem[];
  receipt: ContextReceipt;
}

const HARD_BLOCKLIST = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  ".toki/index/",
  ".toki/receipts/",
  ".toki/checkpoints/",
  "dist/",
  "build/",
  ".next/",
  "coverage/",
  ".git/",
  "node_modules/",
  "*.min.js",
  "*.map"
] as const;

const LOAD_THRESHOLD = 30;
const BASELINE_SCORE = 5;

interface ScoredCandidate {
  path: string;
  normalizedPath: string;
  estimatedTokens: number;
  relevanceScore: number;
  freshness: number;
  priority: number;
  reason: string;
  isTestPath: boolean;
  hasTestSignal: boolean;
  explicitPathMatch: boolean;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function basename(value: string): string {
  const normalized = normalizePath(value);
  const parts = normalized.split("/");
  return parts[parts.length - 1] ?? normalized;
}

function getBlocklistMatch(pathValue: string): string | null {
  const normalized = normalizePath(pathValue);
  const file = basename(normalized);

  for (const entry of HARD_BLOCKLIST) {
    if (entry.startsWith("*")) {
      const suffix = entry.slice(1).toLowerCase();
      if (normalized.endsWith(suffix)) {
        return entry;
      }
      continue;
    }

    if (entry.endsWith("/")) {
      const segment = normalizePath(entry).replace(/\/+$/, "");
      if (
        normalized === segment ||
        normalized.startsWith(`${segment}/`) ||
        normalized.includes(`/${segment}/`)
      ) {
        return entry;
      }
      continue;
    }

    if (file === normalizePath(entry)) {
      return entry;
    }
  }

  return null;
}

export function isBlocked(pathValue: string): boolean {
  return getBlocklistMatch(pathValue) !== null;
}

function isTestPath(pathValue: string): boolean {
  const normalized = normalizePath(pathValue);
  return /(^|\/)(tests?|__tests__|specs?)(\/|$)|\.(test|spec)\./.test(normalized);
}

function stemWithoutTestSuffix(pathValue: string): string {
  const file = basename(pathValue).replace(/\.[^.]+$/, "");
  return file.replace(/(?:\.test|\.spec)$/i, "");
}

function isGeneratedFile(pathValue: string): boolean {
  const normalized = normalizePath(pathValue);
  return (
    normalized.endsWith(".min.js") ||
    normalized.endsWith(".map") ||
    normalized.includes("/generated/") ||
    normalized.includes("/__generated__/")
  );
}

function isConfigOrLockFile(pathValue: string): boolean {
  const file = basename(pathValue);
  if (["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"].includes(file)) {
    return true;
  }

  if (file === "package.json") {
    return false;
  }

  return (
    /^tsconfig(\..+)?\.json$/.test(file) ||
    /^vite\.config\./.test(file) ||
    /^vitest\.config\./.test(file) ||
    /^jest\.config\./.test(file) ||
    /^webpack\.config\./.test(file) ||
    /^rollup\.config\./.test(file) ||
    /^eslint(\..+)?\./.test(file) ||
    /^prettier(\..+)?\./.test(file) ||
    /^babel\.config\./.test(file)
  );
}

function resolveImportCandidate(importerPath: string, rawImport: string, fileSet: Set<string>): string | null {
  if (!rawImport.startsWith(".")) {
    return null;
  }

  const importerDir = normalizePath(path.dirname(importerPath));
  const base = normalizePath(path.posix.normalize(path.posix.join(importerDir, rawImport)));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.json`,
    `${base}.md`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`,
    `${base}/index.mjs`,
    `${base}/index.cjs`
  ];

  for (const candidate of candidates) {
    if (fileSet.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

function hasDomainBoundaryMatch(value: string, token: string): boolean {
  if (token.length === 0) {
    return false;
  }
  const pattern = new RegExp(`(^|[\\/._-])${escapeRegex(token)}([\\/._-]|$)`, "i");
  return pattern.test(value);
}

function chooseAutoMode(task: TaskFrame, repoFileCount: number): BudgetMode {
  if (task.risk === "high") {
    return "deep";
  }
  if (repoFileCount > 1200) {
    return "tiny";
  }
  if (repoFileCount > 300 || task.risk === "medium") {
    return "normal";
  }
  return "normal";
}

function renderSummary(summary: CachedSummary): string {
  return `summary(${summary.summarizer}) ${summary.path}\n${summary.summary}`;
}

function formatSymbols(pathValue: string, symbols: Array<{ name: string; kind: string; lineStart: number; lineEnd: number }>): string {
  const lines = symbols.slice(0, 40).map((symbol) => `${symbol.kind} ${symbol.name} (${symbol.lineStart}-${symbol.lineEnd})`);
  return `symbols ${pathValue}\n${lines.join("\n")}`;
}

function formatImportsExports(pathValue: string, imports: string[], exports: Array<{ name: string }>): string {
  const importsBlock = imports.slice(0, 40).join(", ");
  const exportsBlock = exports.slice(0, 40).map((value) => value.name).join(", ");
  return `imports/exports ${pathValue}\nimports: ${importsBlock || "(none)"}\nexports: ${exportsBlock || "(none)"}`;
}

function cheapSummary(pathValue: string, content: string): string {
  const lines = content.split(/\r?\n/).length;
  const nonEmpty = content.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  const head = content.split(/\r?\n/).slice(0, 25).join("\n");
  return `File: ${pathValue}\nLines: ${lines}\nNon-empty: ${nonEmpty}\nPreview:\n${head}`;
}

export class ContextBroker {
  private mode: BudgetMode;
  private pinnedPaths: Set<string>;
  private droppedPaths: Set<string>;

  public constructor(initialMode: BudgetMode) {
    this.mode = initialMode;
    this.pinnedPaths = new Set();
    this.droppedPaths = new Set();
  }

  public getMode(): BudgetMode {
    return this.mode;
  }

  public setMode(mode: BudgetMode): void {
    this.mode = mode;
  }

  public pin(filePath: string): void {
    const normalized = normalizePath(filePath);
    this.pinnedPaths.add(normalized);
    this.droppedPaths.delete(normalized);
  }

  public drop(filePath: string): void {
    const normalized = normalizePath(filePath);
    this.droppedPaths.add(normalized);
    this.pinnedPaths.delete(normalized);
  }

  public getPinned(): string[] {
    return [...this.pinnedPaths];
  }

  public async selectContext(
    turn: number,
    task: TaskFrame,
    graph: ContextGraph,
    config: GlobalConfig
  ): Promise<BrokerSelection> {
    const state = graph.getState();
    const effectiveMode = this.mode === "auto" ? chooseAutoMode(task, state.files.length) : this.mode;
    const ceiling = modeToCeiling(effectiveMode, config);

    const symbolByPath = new Map<string, SymbolIndexEntry>(state.symbols.map((item) => [normalizePath(item.path), item]));
    const fileSet = new Set(state.files.map((entry) => normalizePath(entry.path)));

    const importedBy = new Map<string, Set<string>>();
    for (const entry of state.files) {
      const normalizedImporter = normalizePath(entry.path);
      const symbolInfo = symbolByPath.get(normalizedImporter);
      if (!symbolInfo) {
        continue;
      }
      for (const imported of symbolInfo.imports) {
        const resolved = resolveImportCandidate(entry.path, imported, fileSet);
        if (!resolved) {
          continue;
        }
        const bucket = importedBy.get(resolved) ?? new Set<string>();
        bucket.add(normalizedImporter);
        importedBy.set(resolved, bucket);
      }
    }

    const skipped: ContextReceipt["skipped"] = [];
    const compressed: ContextReceipt["compressed"] = [];
    const preliminary: ScoredCandidate[] = [];
    let totalRawTokens = 0;

    const pathMentions = task.entities.paths.map((value) => normalizePath(value));
    const symbolMentions = task.entities.symbols.map((value) => value.toLowerCase()).filter((value) => value.length >= 3);
    const domainMentions = task.entities.domains.map((value) => value.toLowerCase());
    const lowerRaw = task.raw.toLowerCase();
    const frameworkQuery = /\b(framework|library|libraries|dependency|dependencies|stack)\b/.test(lowerRaw);

    for (const entry of state.files) {
      const normalizedPath = normalizePath(entry.path);
      const estimatedTokens = Math.max(1, state.tokenCounts[entry.path] ?? entry.estimatedTokens);
      totalRawTokens += estimatedTokens;

      const blockedMatch = getBlocklistMatch(entry.path);
      if (blockedMatch) {
        skipped.push({
          path: entry.path,
          reason: `blocked: ${blockedMatch} is on hard blocklist`,
          estimatedTokens
        });
        continue;
      }

      if (this.droppedPaths.has(normalizedPath)) {
        skipped.push({
          path: entry.path,
          reason: "dropped by user",
          estimatedTokens
        });
        continue;
      }

      const reasons: string[] = [];
      let score = BASELINE_SCORE;
      let hasTestSignal = false;
      const testPath = isTestPath(entry.path);
      const fileBase = basename(entry.path);
      const symbolInfo = symbolByPath.get(normalizedPath);

      const pathMentioned = pathMentions.some(
        (mention) => mention.length > 0 && (normalizedPath.includes(mention) || mention.includes(normalizedPath) || fileBase === basename(mention))
      );
      if (pathMentioned) {
        score += 100;
        reasons.push("path explicitly mentioned");
      }

      const stackTraceSignal =
        task.entities.errors.some((value) => value.toLowerCase().includes(fileBase)) &&
        /\b(stack|traceback| at )\b/i.test(task.raw);
      if (stackTraceSignal) {
        score += 95;
        reasons.push("file appears in stack trace");
      }

      const failingTestSignal =
        testPath &&
        /\b(failing|failed|fail)\b/i.test(task.raw) &&
        (task.entities.errors.some((value) => value.toLowerCase().includes(fileBase)) || pathMentioned);
      if (failingTestSignal) {
        score += 90;
        reasons.push("file appears in failing test output");
        hasTestSignal = true;
      }

      const symbolMatch =
        symbolMentions.length > 0 &&
        symbolInfo?.exports.some((exp) => symbolMentions.some((symbol) => exp.name.toLowerCase().includes(symbol))) === true;
      if (symbolMatch) {
        score += 70;
        reasons.push("symbol name matches task entities");
      }

      const domainMatch =
        domainMentions.some((domain) => hasDomainBoundaryMatch(normalizedPath, domain)) ||
        symbolInfo?.imports.some((imp) => domainMentions.some((domain) => hasDomainBoundaryMatch(imp.toLowerCase(), domain))) === true ||
        (frameworkQuery && (fileBase === "package.json" || fileBase === "readme.md"));
      if (domainMatch) {
        score += 50;
        reasons.push("domain keyword match");
      }

      const freshness = Date.now() - entry.lastModifiedMs <= 24 * 60 * 60 * 1000 ? 1 : 0;
      if (freshness > 0) {
        score += 20;
        reasons.push("recently modified (last 24h)");
      }

      if (isGeneratedFile(entry.path)) {
        score -= 80;
        reasons.push("penalty: generated file");
      }
      if (estimatedTokens > 10000) {
        score -= 40;
        reasons.push("penalty: token count > 10000");
      } else if (estimatedTokens > 5000) {
        score -= 20;
        reasons.push("penalty: token count > 5000");
      }
      if (isConfigOrLockFile(entry.path)) {
        score -= 60;
        reasons.push("penalty: config/lock file");
      }
      if (testPath && !hasTestSignal) {
        score -= 10;
        reasons.push("penalty: test path without test signal");
      }

      preliminary.push({
        path: entry.path,
        normalizedPath,
        estimatedTokens,
        relevanceScore: score,
        freshness,
        priority: Math.round(score),
        reason: reasons.length > 0 ? reasons.join(", ") : "baseline score only",
        isTestPath: testPath,
        hasTestSignal,
        explicitPathMatch: pathMentioned
      });
    }

    const relevantSourceStems = new Set<string>();
    for (const candidate of preliminary) {
      if (!candidate.isTestPath && candidate.relevanceScore >= 50) {
        relevantSourceStems.add(stemWithoutTestSuffix(candidate.path));
      }
    }

    for (const candidate of preliminary) {
      if (candidate.isTestPath && relevantSourceStems.has(stemWithoutTestSuffix(candidate.path))) {
        candidate.relevanceScore += 60;
        candidate.priority = Math.round(candidate.relevanceScore);
        candidate.hasTestSignal = true;
        candidate.reason = `${candidate.reason}, test file for relevant source`;
      }
    }

    const strongPaths = new Set(preliminary.filter((candidate) => candidate.relevanceScore >= 50).map((candidate) => candidate.normalizedPath));
    for (const candidate of preliminary) {
      const importers = importedBy.get(candidate.normalizedPath);
      if (importers && [...importers].some((importer) => strongPaths.has(importer))) {
        candidate.relevanceScore += 40;
        candidate.priority = Math.round(candidate.relevanceScore);
        candidate.reason = `${candidate.reason}, imported by a high-signal file`;
      }
    }

    const thresholdPassed: ScoredCandidate[] = [];
    for (const candidate of preliminary) {
      if (candidate.relevanceScore >= LOAD_THRESHOLD || this.pinnedPaths.has(candidate.normalizedPath)) {
        thresholdPassed.push(candidate);
      } else {
        skipped.push({
          path: candidate.path,
          reason: `low relevance: score ${candidate.relevanceScore}, threshold ${LOAD_THRESHOLD}`,
          estimatedTokens: candidate.estimatedTokens
        });
      }
    }

    const ranked = [...thresholdPassed].sort((left, right) => {
      const leftDensity = left.relevanceScore / Math.max(left.estimatedTokens, 1);
      const rightDensity = right.relevanceScore / Math.max(right.estimatedTokens, 1);
      return (
        rightDensity - leftDensity ||
        right.relevanceScore - left.relevanceScore ||
        left.estimatedTokens - right.estimatedTokens
      );
    });

    const selectedCandidates: ScoredCandidate[] = [];
    let budgetUsedByRaw = 0;
    for (const candidate of ranked) {
      const next = budgetUsedByRaw + candidate.estimatedTokens;
      if (next > ceiling) {
        skipped.push({
          path: candidate.path,
          reason: `over budget: would exceed ${effectiveMode} ceiling`,
          estimatedTokens: candidate.estimatedTokens
        });
        continue;
      }
      selectedCandidates.push(candidate);
      budgetUsedByRaw = next;
    }

    const selected: ContextItem[] = [];
    let usedTokens = 0;

    for (const candidate of selectedCandidates) {
      const fileEntry = graph.getFileEntry(candidate.path);
      if (!fileEntry) {
        continue;
      }

      const abs = path.join(process.cwd(), candidate.path);
      const content = await graph.readFile(candidate.path);
      const summary = graph.getSummary(candidate.path);
      const symbolInfo = graph.findSymbolIndex(candidate.path);

      let representation: FileRepresentation = "outline";
      let body = "";
      let reason = candidate.reason;
      const preferCodeMaterialization =
        task.needsEdit &&
        !candidate.isTestPath &&
        (candidate.explicitPathMatch || candidate.relevanceScore >= 90);

      if (this.pinnedPaths.has(candidate.normalizedPath)) {
        representation = "full_file";
        body = content;
        reason = `${reason}; pinned by user`;
      } else if (preferCodeMaterialization) {
        const lineCount = content.split(/\r?\n/).length;
        if (candidate.estimatedTokens <= 1200 || lineCount <= 220) {
          representation = "full_file";
          body = content;
          reason = `${reason}; full file for edit target`;
        } else {
          const query = task.entities.symbols[0] ?? task.entities.paths[0] ?? task.entities.domains[0] ?? "";
          representation = "targeted_snippet";
          body = takeSnippet(content, query);
          reason = `${reason}; edit-target snippet`;
        }
      } else if (summary && summary.fileHash === fileEntry.hash) {
        representation = "cached_summary";
        body = renderSummary(summary);
        reason = `${reason}; summary reused`;
      } else if (symbolInfo && symbolInfo.exports.length > 0) {
        representation = "symbols";
        body = formatSymbols(candidate.path, symbolInfo.exports);
        reason = `${reason}; symbol extraction`;
      } else if (symbolInfo && symbolInfo.imports.length > 0) {
        representation = "imports_exports";
        body = formatImportsExports(candidate.path, symbolInfo.imports, symbolInfo.exports);
        reason = `${reason}; import/export extraction`;
      } else {
        const query = task.entities.symbols[0] ?? task.entities.paths[0] ?? task.entities.domains[0] ?? "";
        representation = "targeted_snippet";
        body = takeSnippet(content, query);
        reason = `${reason}; targeted snippet`;
      }

      if (body.trim().length === 0) {
        const staticData = extractStaticData(abs, content);
        representation = "outline";
        body = staticData.outline.join("\n");
        reason = `${reason}; outline fallback`;
      }

      if (body.trim().length === 0) {
        representation = "cached_summary";
        body = cheapSummary(candidate.path, content);
        reason = `${reason}; fallback summary`;
        const tokenCount = estimateTokens(body);
        graph.upsertSummary(candidate.path, {
          path: candidate.path,
          fileHash: fileEntry.hash,
          summary: body,
          tokenCount,
          createdAt: new Date().toISOString(),
          summarizer: "static-fallback"
        });
      }

      const estTokens = estimateTokens(body);
      selected.push({
        id: `${candidate.path}:${representation}`,
        type: "file",
        path: candidate.path,
        representation,
        content: body,
        estimatedTokens: estTokens,
        relevanceScore: candidate.relevanceScore,
        freshness: candidate.freshness,
        source: candidate.path,
        reason,
        priority: candidate.priority
      });
      usedTokens += estTokens;

      if (candidate.estimatedTokens > estTokens) {
        compressed.push({
          source: candidate.path,
          fromTokens: candidate.estimatedTokens,
          toTokens: estTokens,
          method: representation
        });
      }
    }

    await graph.flushSummaries();

    const savedTokens = Math.max(totalRawTokens - usedTokens, 0);

    return {
      items: selected,
      receipt: {
        turn,
        mode: effectiveMode,
        ceiling,
        usedTokens,
        savedTokens,
        loaded: selected,
        skipped,
        compressed
      }
    };
  }
}
