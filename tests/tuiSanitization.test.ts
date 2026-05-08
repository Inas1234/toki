import { describe, expect, test } from "vitest";
import { parseMarkdownSegmentsForTest, sanitizeRenderableContent } from "../packages/tui/src/index.js";

describe("sanitizeRenderableContent", () => {
  test("strips internal tool-call protocol blocks from rendered content", () => {
    const content = [
      "Checked the repo.",
      "[TOOL_CALL]",
      '{tool: "read", path: "README.md"}',
      "[/TOOL_CALL]",
      "",
      "Ready to continue."
    ].join("\n");

    expect(sanitizeRenderableContent(content)).toBe("Checked the repo.\n\nReady to continue.");
  });

  test("strips relaxed tool object lines from rendered content", () => {
    const content = [
      "Done inspecting.",
      "{tool: \"read\", path: \"README.md\"}",
      "{\"tool\":\"edit\",\"path\":\"README.md\"}",
      "",
      "Continuing with summary."
    ].join("\n");

    expect(sanitizeRenderableContent(content)).toBe("Done inspecting.\n\nContinuing with summary.");
  });

  test("parses fenced code blocks with CRLF and preserves surrounding text", () => {
    const content = [
      "Before block.",
      "```ts\r",
      "const value = 1;\r",
      "```",
      "After block."
    ].join("\n");

    const segments = parseMarkdownSegmentsForTest(content);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({ kind: "text" });
    expect(segments[1]).toEqual({ kind: "code", language: "ts", value: "const value = 1;" });
    expect(segments[2]).toMatchObject({ kind: "text" });
  });

  test("does not treat diff-prefixed fenced markers as code blocks", () => {
    const content = [
      "  L @@ diff @@",
      "  - ```text",
      "  - README.md | 1 +",
      "  - ```",
      "  + Done"
    ].join("\n");

    const segments = parseMarkdownSegmentsForTest(content);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({ kind: "text", value: sanitizeRenderableContent(content) });
  });
});
