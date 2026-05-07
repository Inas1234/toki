import path from "node:path";
import Parser, { SyntaxNode, Tree } from "tree-sitter";
import TypeScriptGrammar from "tree-sitter-typescript";

export interface ExtractedSymbol {
  name: string;
  kind: string;
  lineStart: number;
  lineEnd: number;
}

export interface StaticExtraction {
  symbols: ExtractedSymbol[];
  imports: string[];
  exports: string[];
  outline: string[];
  parserUsed: "tree-sitter" | "regex";
}

const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function createParser(filePath: string): Parser | null {
  const ext = path.extname(filePath).toLowerCase();
  if (!EXTENSIONS.has(ext)) {
    return null;
  }
  try {
    const parser = new Parser();
    const grammar = TypeScriptGrammar as unknown as { tsx: unknown; typescript: unknown };
    const language = ext === ".tsx" || ext === ".jsx" ? grammar.tsx : grammar.typescript;
    parser.setLanguage(language as never);
    return parser;
  } catch {
    return null;
  }
}

function extractNameNode(node: SyntaxNode): string | undefined {
  const candidate = node.childForFieldName("name");
  if (candidate?.text) {
    return candidate.text;
  }
  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    const declaration = node.namedChildren.find((child) => child.type === "variable_declarator");
    const name = declaration?.childForFieldName("name")?.text;
    return name;
  }
  return undefined;
}

function recurse(node: SyntaxNode, list: ExtractedSymbol[]): void {
  const interesting = new Set([
    "function_declaration",
    "class_declaration",
    "method_definition",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "lexical_declaration",
    "variable_declaration"
  ]);

  if (interesting.has(node.type)) {
    const name = extractNameNode(node);
    if (name) {
      list.push({
        name,
        kind: node.type,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1
      });
    }
  }

  for (const child of node.namedChildren) {
    recurse(child, list);
  }
}

function extractImportsExportsRegex(content: string): { imports: string[]; exports: string[] } {
  const imports = new Set<string>();
  const exports = new Set<string>();
  const importRegex = /^\s*import\s+.+?from\s+["'](.+?)["']/gm;
  const exportRegex = /^\s*export\s+(?:default\s+)?(?:class|function|const|let|var|type|interface|enum)?\s*([A-Za-z0-9_$]+)?/gm;

  for (const match of content.matchAll(importRegex)) {
    const value = match[1];
    if (value) {
      imports.add(value);
    }
  }

  for (const match of content.matchAll(exportRegex)) {
    const value = match[1];
    if (value) {
      exports.add(value);
    } else {
      exports.add("default");
    }
  }

  return { imports: [...imports], exports: [...exports] };
}

function outlineFromContent(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line, index) => ({ line, index: index + 1 }))
    .filter((entry) => /^\s*(export\s+)?(class|function|interface|type|const|let|enum)\s+/u.test(entry.line))
    .map((entry) => `${entry.index}: ${entry.line.trim()}`)
    .slice(0, 80);
}

function extractFromTree(tree: Tree): Pick<StaticExtraction, "symbols" | "imports" | "exports"> {
  const symbols: ExtractedSymbol[] = [];
  recurse(tree.rootNode, symbols);
  const imports = new Set<string>();
  const exports = new Set<string>();

  const queue: SyntaxNode[] = [tree.rootNode];
  while (queue.length > 0) {
    const node = queue.pop();
    if (!node) {
      continue;
    }
    if (node.type === "import_statement") {
      const source = node.childForFieldName("source")?.text?.replace(/["']/g, "");
      if (source) {
        imports.add(source);
      }
    }
    if (node.type.startsWith("export")) {
      const name = node.childForFieldName("name")?.text;
      exports.add(name ?? "default");
    }
    queue.push(...node.namedChildren);
  }

  return {
    symbols,
    imports: [...imports],
    exports: [...exports]
  };
}

export function extractStaticData(filePath: string, content: string): StaticExtraction {
  const parser = createParser(filePath);
  const outline = outlineFromContent(content);
  if (parser) {
    try {
      const tree = parser.parse(content);
      const parsed = extractFromTree(tree);
      return {
        symbols: parsed.symbols,
        imports: parsed.imports,
        exports: parsed.exports,
        outline,
        parserUsed: "tree-sitter"
      };
    } catch {
      // Fall through to regex mode.
    }
  }

  const regex = extractImportsExportsRegex(content);
  return {
    symbols: outline.map((line) => ({
      name: line,
      kind: "outline",
      lineStart: Number.parseInt(line.split(":")[0] ?? "1", 10),
      lineEnd: Number.parseInt(line.split(":")[0] ?? "1", 10)
    })),
    imports: regex.imports,
    exports: regex.exports,
    outline,
    parserUsed: "regex"
  };
}
