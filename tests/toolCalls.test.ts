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

  test("drops invalid or incomplete calls", () => {
    const text = JSON.stringify([
      { tool: "search_files", path: "src" },
      { tool: "replace_in_file", path: "src/index.ts", find: "a" },
      { tool: "write_file", path: "src/new.ts", content: "export {};" }
    ]);

    const calls = parseToolCallsFromText(text);
    expect(calls).toEqual([{ tool: "write_file", path: "src/new.ts", content: "export {};" }]);
  });
});
