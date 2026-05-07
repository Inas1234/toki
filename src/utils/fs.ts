import { createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";

export interface WalkOptions {
  ignoredNames?: Set<string>;
  ignoredPrefixes?: string[];
  maxFileSizeBytes?: number;
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readTextFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf8");
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  if (!(await fileExists(filePath))) {
    return fallback;
  }
  const raw = await readTextFile(filePath);
  return JSON.parse(raw) as T;
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function listFilesRecursive(root: string, options: WalkOptions = {}): Promise<string[]> {
  const ignoredNames = options.ignoredNames ?? new Set<string>();
  const ignoredPrefixes = options.ignoredPrefixes ?? [];
  const maxFileSizeBytes = options.maxFileSizeBytes ?? 1024 * 1024;
  const out: string[] = [];

  async function walk(dirPath: string): Promise<void> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (ignoredNames.has(entry.name)) {
          return;
        }
        const abs = path.join(dirPath, entry.name);
        const rel = path.relative(root, abs);
        if (ignoredPrefixes.some((prefix) => rel.startsWith(prefix))) {
          return;
        }
        if (entry.isDirectory()) {
          await walk(abs);
          return;
        }
        if (!entry.isFile()) {
          return;
        }
        const stat = await fs.stat(abs);
        if (stat.size > maxFileSizeBytes) {
          return;
        }
        out.push(abs);
      })
    );
  }

  await walk(root);
  return out;
}

export async function getFileStat(filePath: string): Promise<{ sizeBytes: number; modifiedMs: number }> {
  const stat = await fs.stat(filePath);
  return { sizeBytes: stat.size, modifiedMs: stat.mtimeMs };
}

export function createLineReader(filePath: string): readline.Interface {
  return readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
}

export async function appendLine(filePath: string, line: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const stream = createWriteStream(filePath, { flags: "a", encoding: "utf8" });
  await new Promise<void>((resolve, reject) => {
    stream.write(`${line}\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      stream.end(resolve);
    });
  });
}
