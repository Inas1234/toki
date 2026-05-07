import { describe, expect, test } from "vitest";
import { sanitizeRenderableContent } from "../packages/tui/src/index.js";

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
});
