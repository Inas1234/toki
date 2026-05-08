import { stat } from "node:fs/promises";
import path from "node:path";
import { listFilesRecursive, readTextFile } from "@toki/shared";
import type { ToolCallByName, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { clampLimit, globToRegExp, resolveWorkspacePath } from "./helpers.js";

const DEFAULT_LIMIT = 100;
const SEARCH_TOKEN_STOPWORDS = new Set(["a", "an", "and", "the", "for", "with", "from", "that", "this", "into", "onto"]);

export interface GrepOperations {
  stat: typeof stat;
  listFilesRecursive: (absolutePath: string) => Promise<string[]>;
  readTextFile: (absolutePath: string) => Promise<string>;
}

const defaultOperations: GrepOperations = {
  stat,
  listFilesRecursive,
  readTextFile
};

export interface GrepToolOptions {
  operations?: GrepOperations;
}

interface SearchFallbackCandidate {
  path: string;
  lineNumber: number;
  line: string;
  score: number;
}

function extractSearchTokens(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !SEARCH_TOKEN_STOPWORDS.has(token));
  return [...new Set(tokens)];
}

function buildMatcher(pattern: string, literal: boolean, ignoreCase: boolean): (value: string) => boolean {
  if (literal) {
    const needle = ignoreCase ? pattern.toLowerCase() : pattern;
    return (value: string) => (ignoreCase ? value.toLowerCase() : value).includes(needle);
  }

  try {
    const regex = new RegExp(pattern, ignoreCase ? "i" : "");
    return (value: string) => regex.test(value);
  } catch {
    const needle = ignoreCase ? pattern.toLowerCase() : pattern;
    return (value: string) => (ignoreCase ? value.toLowerCase() : value).includes(needle);
  }
}

export function createGrepToolDefinition(cwd: string, options?: GrepToolOptions): ToolDefinition<ToolCallByName<"grep">> {
  const ops = options?.operations ?? defaultOperations;
  return {
    name: "grep",
    description: "Search file contents for a pattern.",
    promptSnippet: "Search file contents for patterns (respects .gitignore)",
    async execute(call: ToolCallByName<"grep">, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
      const targetPath = resolveWorkspacePath(cwd, call.path ?? ".");
      const targetStat = await ops.stat(targetPath);
      const allFiles = targetStat.isDirectory() ? await ops.listFilesRecursive(targetPath) : [targetPath];
      const globMatcher = call.glob ? globToRegExp(call.glob) : null;
      const matcher = buildMatcher(call.pattern, call.literal ?? false, call.ignoreCase ?? false);
      const max = clampLimit(call.limit, 500, DEFAULT_LIMIT);
      const exactMatches: string[] = [];
      const fallbackCandidates: SearchFallbackCandidate[] = [];
      const fallbackTokens = /\s/.test(call.pattern) ? extractSearchTokens(call.pattern) : [];
      const repoRelativeBase = targetStat.isDirectory() ? targetPath : path.dirname(targetPath);

      for (const filePath of allFiles) {
        if (exactMatches.length >= max) {
          break;
        }
        const relativePath = path.relative(repoRelativeBase, filePath).replace(/\\/g, "/");
        if (globMatcher && !globMatcher.test(relativePath)) {
          continue;
        }
        const body = await ops.readTextFile(filePath);
        const rows = body.split(/\r?\n/);
        const rel = targetStat.isDirectory()
          ? relativePath
          : path.relative(path.resolve(cwd), filePath).replace(/\\/g, "/");
        const relLower = rel.toLowerCase();

        for (let index = 0; index < rows.length; index += 1) {
          const line = rows[index]!;
          if (matcher(line)) {
            exactMatches.push(`${rel}:${index + 1}: ${line}`);
            if (exactMatches.length >= max) {
              break;
            }
            continue;
          }

          if (fallbackTokens.length > 0) {
            const lineLower = line.toLowerCase();
            const tokenHits = fallbackTokens.reduce((count, token) => {
              return lineLower.includes(token) || relLower.includes(token) ? count + 1 : count;
            }, 0);
            if (tokenHits > 0) {
              fallbackCandidates.push({
                path: rel,
                lineNumber: index + 1,
                line,
                score: tokenHits
              });
            }
          }
        }
      }

      const matches =
        exactMatches.length > 0
          ? exactMatches
          : fallbackCandidates
              .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.lineNumber - right.lineNumber)
              .slice(0, max)
              .map((candidate) => `${candidate.path}:${candidate.lineNumber}: ${candidate.line}`);

      const displayLines = [`  L FOUND ${matches.length} match(es) for "${call.pattern}"`];
      for (const match of matches.slice(0, 5)) {
        displayLines.push(`  | ${match}`);
      }
      if (matches.length > 5) {
        displayLines.push(`  L ... ${matches.length - 5} more match(es) omitted`);
      }

      return {
        action: `GREP(${call.path ?? "."}, ${JSON.stringify(call.pattern)})`,
        displayLines,
        report: `grep ${call.path ?? "."} pattern="${call.pattern}"\n${matches.join("\n") || "(none)"}`,
        mutationSuccessCount: 0
      };
    }
  };
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): ToolDefinition<ToolCallByName<"grep">> {
  return createGrepToolDefinition(cwd, options);
}
