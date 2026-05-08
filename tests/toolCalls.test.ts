import { describe, expect, test } from "vitest";
import { parseToolCallsFromText } from "../src/core/toolCalls.js";

describe("parseToolCallsFromText", () => {
  test("parses strict tool call JSON array", () => {
    const calls = parseToolCallsFromText(
      '[{"tool":"read","path":"src/index.ts","offset":1,"limit":40},{"tool":"grep","path":"src","pattern":"provider"}]'
    );

    expect(calls).toEqual([
      { tool: "read", path: "src/index.ts", offset: 1, limit: 40 },
      { tool: "grep", path: "src", pattern: "provider" }
    ]);
  });

  test("parses calls wrapped in tags and markdown fences", () => {
    const text = [
      "I will inspect files now.",
      "<tool_calls>",
      "```json",
      '[{"tool":"ls","path":"src","limit":25}]',
      "```",
      "</tool_calls>"
    ].join("\n");

    const calls = parseToolCallsFromText(text);
    expect(calls).toEqual([{ tool: "ls", path: "src", limit: 25 }]);
  });

  test("parses bracketed tool blocks with relaxed object syntax", () => {
    const text = [
      "[TOOL_CALL]",
      '{tool: "read", path: "README.md"}',
      '{tool: "ls", path: ".", limit: 20}',
      "[/TOOL_CALL]"
    ].join("\n");

    const calls = parseToolCallsFromText(text);
    expect(calls).toEqual([
      { tool: "read", path: "README.md" },
      { tool: "ls", path: ".", limit: 20 }
    ]);
  });

  test("parses OpenAI-style function tool calls", () => {
    const text = JSON.stringify({
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "edit",
            arguments: JSON.stringify({
              path: "README.md",
              edits: [{ oldText: "foo", newText: "bar" }]
            })
          }
        }
      ]
    });

    const calls = parseToolCallsFromText(text);
    expect(calls).toEqual([
      {
        tool: "edit",
        path: "README.md",
        edits: [{ oldText: "foo", newText: "bar" }]
      }
    ]);
  });

  test("normalizes tool aliases and numeric strings", () => {
    const text = JSON.stringify([
      {
        name: "read-file",
        arguments: {
          path: "src/core/engine.ts",
          offset: "10",
          limit: "11"
        }
      }
    ]);

    const calls = parseToolCallsFromText(text);
    expect(calls).toEqual([{ tool: "read", path: "src/core/engine.ts", offset: 10, limit: 11 }]);
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
    expect(calls).toEqual([{ tool: "read", path: "src/core/engine.ts", offset: 21, limit: 10 }]);
  });

  test("parses pi-style edit calls as canonical edit operations", () => {
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
      {
        tool: "edit",
        path: "src/core/engine.ts",
        edits: [
          { oldText: "const a = 1;", newText: "const a = 2;" },
          { oldText: "const b = 3;", newText: "const b = 4;" }
        ]
      }
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
    expect(calls).toEqual([
      {
        tool: "edit",
        path: "README.md",
        edits: [{ oldText: "hello", newText: "goodbye" }]
      }
    ]);
  });

  test("drops invalid or incomplete calls", () => {
    const text = JSON.stringify([
      { tool: "grep", path: "src" },
      { tool: "edit", path: "src/index.ts", edits: [] },
      { tool: "write", path: "src/new.ts", content: "export {};" }
    ]);

    const calls = parseToolCallsFromText(text);
    expect(calls).toEqual([{ tool: "write", path: "src/new.ts", content: "export {};" }]);
  });

  test("parses bash calls with aliases and timeout strings", () => {
    const text = JSON.stringify([
      {
        name: "shell",
        arguments: {
          command: "npm test",
          timeout: "120"
        }
      }
    ]);

    const calls = parseToolCallsFromText(text);
    expect(calls).toEqual([{ tool: "bash", command: "npm test", timeout: 120 }]);
  });
});
