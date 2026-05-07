import { describe, expect, test } from "vitest";
import { buildTaskFrame } from "../src/core/task/taskFrame.js";

describe("buildTaskFrame", () => {
  test("extracts intent and entities", () => {
    const frame = buildTaskFrame("Fix error in src/app.ts around AuthService and add tests");
    expect(frame.intent).toBe("debug_and_fix");
    expect(frame.entities.paths).toContain("src/app.ts");
    expect(frame.entities.symbols).toContain("AuthService");
    expect(frame.needsEdit).toBe(true);
    expect(frame.needsTests).toBe(true);
  });

  test("marks direct implementation requests as edit tasks", () => {
    const frame = buildTaskFrame("Update src/core/engine.ts to force tool calls for edit tasks");
    expect(frame.intent).toBe("implement_feature");
    expect(frame.needsEdit).toBe(true);
  });

  test("keeps explanatory questions out of edit mode", () => {
    const frame = buildTaskFrame("How does the context broker choose files?");
    expect(frame.needsEdit).toBe(false);
  });

  test("does not treat sentence-leading English verbs as code symbols", () => {
    const frame = buildTaskFrame(
      "Fix a cursor position bug where tab completion leaves the cursor in the middle of the command."
    );
    expect(frame.entities.symbols).not.toContain("Fix");
  });

  test("ignores pasted tool transcript paths when extracting task targets", () => {
    const frame = buildTaskFrame([
      'SEARCH(packages/tui/src, "tab completion cursor")',
      "READ(src/cli/App.tsx)",
      "TOOLING(.)",
      "",
      "Check exactly what is causing my agent to fail to find something and fix it.",
      "Ignore the cursor stuff, that is just an example."
    ].join("\n"));

    expect(frame.entities.paths).not.toContain("packages/tui/src");
    expect(frame.entities.paths).not.toContain("src/cli/App.tsx");
  });

  test("adds internal engine domains for agent debugging requests", () => {
    const frame = buildTaskFrame("Check why the coding agent fails to search the codebase and fix it.");

    expect(frame.entities.domains).toEqual(expect.arrayContaining(["engine", "tool", "context"]));
  });
});
