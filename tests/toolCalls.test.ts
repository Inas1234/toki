import { describe, expect, test } from "vitest";
import { parseToolCallsFromText } from "../src/core/toolCalls.js";

describe("parseToolCallsFromText", () => {
  test("parses strict tool call JSON array", () => {
    const calls = parseToolCallsFromText(
      '[{"tool":"read_file","path":"src/index.ts","start_line":1,"end_line":40},{"tool":"search_files","path":"src","query":"provider"}]'
    );

    expect(calls).toEqual([
      { tool: "read_file", path: "src/index.ts", start_line: 1, end_line: 40 },
      { tool: "search_files", path: "src", query: "provider" }
    ]);
  });

  test("parses calls wrapped in tags and markdown fences", () => {
    const text = [
      "I will inspect files now.",
      "<tool_calls>",
      "```json",
      '[{"tool":"list_files","path":"src","max_results":25}]',
      "```",
      "</tool_calls>"
    ].join("\n");

    const calls = parseToolCallsFromText(text);
    expect(calls).toEqual([{ tool: "list_files", path: "src", max_results: 25 }]);
  });

  test("parses bracketed tool blocks with relaxed object syntax", () => {
    const text = [
      "[TOOL_CALL]",
      '{tool: "read", path: "README.md"}',
      '{tool: "list_files", path: ".", max_results: 20}',
      "[/TOOL_CALL]"
    ].join("\n");

    const calls = parseToolCallsFromText(text);
    expect(calls).toEqual([
      { tool: "read_file", path: "README.md" },
      { tool: "list_files", path: ".", max_results: 20 }
    ]);
  });

  test("parses OpenAI-style function tool calls", () => {
    const text = JSON.stringify({
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "replace_in_file",
            arguments: JSON.stringify({
              path: "README.md",
              find: "foo",
              replace: "bar"
            })
          }
        }
      ]
    });

    const calls = parseToolCallsFromText(text);
    expect(calls).toEqual([{ tool: "replace_in_file", path: "README.md", find: "foo", replace: "bar" }]);
  });

  test("normalizes tool aliases and numeric strings", () => {
    const text = JSON.stringify([
      {
        name: "read-file",
        arguments: {
          path: "src/core/engine.ts",
          start_line: "10",
          end_line: "20"
        }
      }
    ]);

    const calls = parseToolCallsFromText(text);
    expect(calls).toEqual([{ tool: "read_file", path: "src/core/engine.ts", start_line: 10, end_line: 20 }]);
  });

  test("parses pi-style read offsets and limits", () => {
    const text = JSON.stringify([
      {
        name: "read",
        arguments: {
          path: "src/core/engine.ts",
          offset: 21,
          limit: 10
        }
      }
    ]);

    const calls = parseToolCallsFromText(text);
    expect(calls).toEqual([{ tool: "read_file", path: "src/core/engine.ts", start_line: 21, end_line: 30 }]);
  });

  test("parses pi-style edit calls into replace operations", () => {
    const text = JSON.stringify([
      {
        name: "edit",
        arguments: {
          path: "src/core/engine.ts",
          edits: [
            { oldText: "const a = 1;", newText: "const a = 2;" },
            { oldText: "const b = 3;", newText: "const b = 4;" }
          ]
        }
      }
    ]);

    const calls = parseToolCallsFromText(text);
    expect(calls).toEqual([
      { tool: "replace_in_file", path: "src/core/engine.ts", find: "const a = 1;", replace: "const a = 2;" },
      { tool: "replace_in_file", path: "src/core/engine.ts", find: "const b = 3;", replace: "const b = 4;" }
    ]);
  });

  test("parses legacy edit oldText/newText fields", () => {
    const text = JSON.stringify([
      {
        name: "edit",
        arguments: {
          path: "README.md",
          oldText: "hello",
          newText: "goodbye"
        }
      }
    ]);

    const calls = parseToolCallsFromText(text);
    expect(calls).toEqual([{ tool: "replace_in_file", path: "README.md", find: "hello", replace: "goodbye" }]);
  });

  test("drops invalid or incomplete calls", () => {
    const text = JSON.stringify([
      { tool: "search_files", path: "src" },
      { tool: "replace_in_file", path: "src/index.ts", find: "a" },
      { tool: "write_file", path: "src/new.ts", content: "export {};" }
    ]);

    const calls = parseToolCallsFromText(text);
    expect(calls).toEqual([{ tool: "write_file", path: "src/new.ts", content: "export {};" }]);
  });

  test("parses run_command calls with aliases and timeout strings", () => {
    const text = JSON.stringify([
      {
        name: "shell",
        arguments: {
          command: "npm test",
          cwd: "..",
          timeout_ms: "120000"
        }
      }
    ]);

    const calls = parseToolCallsFromText(text);
    expect(calls).toEqual([{ tool: "run_command", command: "npm test", cwd: "..", timeout_ms: 120000 }]);
  });
});
