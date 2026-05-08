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

  test("derives a clean objective from transcript-heavy edit failures", () => {
    const frame = buildTaskFrame(
      [
        "TOOLING(.)",
        "  L INFO Model returned no valid tool calls on edit task (retry 1).",
        "READ(README.md)",
        "READ(package.json)",
        "",
        "EDIT(README.md)",
        "  L UPDATED README.md",
        "  L @@ diff @@",
        "  - # Build the UI package",
        "  + # Build all packages (required before running)",
        "",
        "I'll update the README to better reflect the current project setup and configuration.",
        "",
        "Why is this happening i mean why cant it understand the actual context or whatever how does this work in other AI coding agents and why is mine so stupid i dont get it the model i am using isnt bad like it is not the models fault it is the agent fault",
        "",
        "implement it"
      ].join("\n")
    );

    expect(frame.objective).toContain("implement it");
    expect(frame.objective).toContain("why cant it understand the actual context");
    expect(frame.objective).not.toContain("README.md");
    expect(frame.objective).not.toContain("package.json");
    expect(frame.entities.paths).not.toContain("README.md");
    expect(frame.entities.paths).not.toContain("package.json");
    expect(frame.entities.paths).not.toContain("a/README.md");
    expect(frame.entities.paths).not.toContain("b/README.md");
  });
});
