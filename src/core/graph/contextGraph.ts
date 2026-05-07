import path from "node:path";
import {
  CandidateFile,
  FileIndexEntry,
  RepoConfig,
  RepoIndexState,
  SymbolIndexEntry,
  TaskFrame
} from "../types.js";
import { getFileStat, listFilesRecursive, readJsonFile, readTextFile, writeJsonFile } from "../../utils/fs.js";
import { sha1 } from "../../utils/hash.js";
import { estimateTokens } from "../../utils/tokens.js";
import { extractStaticData } from "../../utils/treeSitter.js";

interface GraphPaths {
  repoMapPath: string;
  symbolsPath: string;
  summariesPath: string;
  tokenCountsPath: string;
}

function defaultState(): RepoIndexState {
  return {
    generatedAt: new Date(0).toISOString(),
    files: [],
    symbols: [],
    tokenCounts: {},
    summaries: {}
  };
}

function isSourceFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".mjs", ".cjs", ".py", ".go", ".rs", ".java"].includes(ext);
}

export class ContextGraph {
  private readonly cwd: string;
  private readonly config: RepoConfig;
  private readonly graphPaths: GraphPaths;
  private state: RepoIndexState;
  private backgroundTask: Promise<void> | null;

  public constructor(cwd: string, config: RepoConfig, repoIndexDir: string) {
    this.cwd = cwd;
    this.config = config;
    this.graphPaths = {
      repoMapPath: path.join(repoIndexDir, "repo-map.json"),
      symbolsPath: path.join(repoIndexDir, "symbols.json"),
      summariesPath: path.join(repoIndexDir, "summaries.json"),
      tokenCountsPath: path.join(repoIndexDir, "token-counts.json")
    };
    this.state = defaultState();
    this.backgroundTask = null;
  }

  public async initialize(): Promise<void> {
    const [repoMap, symbols, summaries, tokenCounts] = await Promise.all([
      readJsonFile<FileIndexEntry[]>(this.graphPaths.repoMapPath, []),
      readJsonFile<SymbolIndexEntry[]>(this.graphPaths.symbolsPath, []),
      readJsonFile<Record<string, RepoIndexState["summaries"][string]>>(this.graphPaths.summariesPath, {}),
      readJsonFile<Record<string, number>>(this.graphPaths.tokenCountsPath, {})
    ]);

    this.state = {
      generatedAt: new Date().toISOString(),
      files: repoMap,
      symbols,
      summaries,
      tokenCounts
    };

    if (this.state.files.length === 0) {
      await this.bootstrapQuickMap();
    }
    this.startBackgroundIndexing();
  }

  public async waitForIndexing(): Promise<void> {
    if (this.backgroundTask) {
      await this.backgroundTask;
    }
  }

  public getState(): RepoIndexState {
    return this.state;
  }

  public findSymbolIndex(pathOrFile: string): SymbolIndexEntry | undefined {
    return this.state.symbols.find((item) => item.path === pathOrFile);
  }

  public getSummary(pathOrFile: string): RepoIndexState["summaries"][string] | undefined {
    return this.state.summaries[pathOrFile];
  }

  public getFileEntry(pathOrFile: string): FileIndexEntry | undefined {
    return this.state.files.find((entry) => entry.path === pathOrFile);
  }

  public upsertSummary(pathOrFile: string, summary: RepoIndexState["summaries"][string]): void {
    this.state.summaries[pathOrFile] = summary;
  }

  public async flushSummaries(): Promise<void> {
    await writeJsonFile(this.graphPaths.summariesPath, this.state.summaries);
  }

  public async readFile(pathOrFile: string): Promise<string> {
    const abs = path.isAbsolute(pathOrFile) ? pathOrFile : path.join(this.cwd, pathOrFile);
    return readTextFile(abs);
  }

  public getCandidateFiles(task: TaskFrame): CandidateFile[] {
    const pathMentions = new Set(task.entities.paths.map((value) => value.toLowerCase()));
    const symbolMentions = new Set(task.entities.symbols.map((value) => value.toLowerCase()));
    const domainMentions = new Set(task.entities.domains.map((value) => value.toLowerCase()));
    const important = new Set(this.config.importantPaths.map((value) => value.toLowerCase()));

    const files = this.state.files.map((entry): CandidateFile => {
      const normalizedPath = entry.path.toLowerCase();
      let relevance = 0.1;
      const reasons: string[] = [];

      for (const mention of pathMentions) {
        if (normalizedPath.includes(mention)) {
          relevance += 0.45;
          reasons.push(`path match: ${mention}`);
        }
      }

      const symbolInfo = this.state.symbols.find((item) => item.path === entry.path);
      if (symbolInfo) {
        for (const symbol of symbolMentions) {
          if (symbolInfo.exports.some((item) => item.name.toLowerCase().includes(symbol))) {
            relevance += 0.35;
            reasons.push(`symbol match: ${symbol}`);
          }
        }
        for (const domain of domainMentions) {
          if (symbolInfo.imports.some((item) => item.toLowerCase().includes(domain))) {
            relevance += 0.2;
            reasons.push(`import/domain: ${domain}`);
          }
        }
      }

      if (important.has(normalizedPath) || [...important].some((prefix) => normalizedPath.startsWith(prefix))) {
        relevance += 0.2;
        reasons.push("important path");
      }

      const ageHours = Math.max((Date.now() - entry.lastModifiedMs) / 36e5, 1);
      const freshness = Math.max(0.1, Math.min(1, 24 / ageHours));
      relevance += freshness * 0.05;

      return {
        path: entry.path,
        estimatedTokens: this.state.tokenCounts[entry.path] ?? entry.estimatedTokens,
        relevanceScore: Math.min(relevance, 1.2),
        freshness,
        priority: Math.round(relevance * 100),
        reason: reasons.length > 0 ? reasons.join(", ") : "baseline candidate"
      };
    });

    return files
      .filter((item) => item.estimatedTokens > 0)
      .sort((left, right) => right.relevanceScore - left.relevanceScore || left.estimatedTokens - right.estimatedTokens);
  }

  private async bootstrapQuickMap(): Promise<void> {
    const ignored = new Set(["node_modules", ".git", "dist"]);
    const ignoredPrefixes = this.config.generatedPaths;
    const files = await listFilesRecursive(this.cwd, {
      ignoredNames: ignored,
      ignoredPrefixes,
      maxFileSizeBytes: 512 * 1024
    });

    const out: FileIndexEntry[] = [];
    for (const filePath of files) {
      if (!isSourceFile(filePath)) {
        continue;
      }
      const rel = path.relative(this.cwd, filePath).replace(/\\/g, "/");
      const stat = await getFileStat(filePath);
      out.push({
        path: rel,
        ext: path.extname(filePath).toLowerCase(),
        sizeBytes: stat.sizeBytes,
        estimatedTokens: Math.max(1, Math.ceil(stat.sizeBytes / 4)),
        lastModifiedMs: stat.modifiedMs,
        hash: ""
      });
    }
    this.state.files = out;
    this.state.generatedAt = new Date().toISOString();
    await writeJsonFile(this.graphPaths.repoMapPath, out);
  }

  private startBackgroundIndexing(): void {
    if (this.backgroundTask) {
      return;
    }
    this.backgroundTask = this.rebuildIndex()
      .catch(() => {
        // Keep session alive even when indexing fails.
      })
      .finally(() => {
        this.backgroundTask = null;
      });
  }

  private async rebuildIndex(): Promise<void> {
    const files = await listFilesRecursive(this.cwd, {
      ignoredNames: new Set(["node_modules", ".git", "dist"]),
      ignoredPrefixes: this.config.generatedPaths,
      maxFileSizeBytes: 1024 * 1024
    });

    const fileEntries: FileIndexEntry[] = [];
    const symbolEntries: SymbolIndexEntry[] = [];
    const tokenCounts: Record<string, number> = {};

    for (const filePath of files) {
      if (!isSourceFile(filePath)) {
        continue;
      }
      const rel = path.relative(this.cwd, filePath).replace(/\\/g, "/");
      const content = await readTextFile(filePath);
      const stat = await getFileStat(filePath);
      const hash = sha1(content);
      const tokens = estimateTokens(content);
      tokenCounts[rel] = tokens;
      fileEntries.push({
        path: rel,
        ext: path.extname(filePath).toLowerCase(),
        sizeBytes: stat.sizeBytes,
        estimatedTokens: tokens,
        lastModifiedMs: stat.modifiedMs,
        hash
      });

      const staticData = extractStaticData(filePath, content);
      symbolEntries.push({
        path: rel,
        exports: staticData.symbols.map((symbol) => ({
          name: symbol.name,
          kind: symbol.kind,
          lineStart: symbol.lineStart,
          lineEnd: symbol.lineEnd
        })),
        imports: staticData.imports
      });
    }

    this.state = {
      ...this.state,
      generatedAt: new Date().toISOString(),
      files: fileEntries,
      symbols: symbolEntries,
      tokenCounts
    };

    await Promise.all([
      writeJsonFile(this.graphPaths.repoMapPath, fileEntries),
      writeJsonFile(this.graphPaths.symbolsPath, symbolEntries),
      writeJsonFile(this.graphPaths.tokenCountsPath, tokenCounts),
      writeJsonFile(this.graphPaths.summariesPath, this.state.summaries)
    ]);
  }
}
