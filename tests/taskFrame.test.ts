import { describe, expect, test } from "vitest";
import { buildTaskFrame } from "../src/core/task/taskFrame.js";

describe("buildTaskFrame", () => {
  test("extracts intent and entities", () => {
    const frame = buildTaskFrame("Fix error in src/app.ts around AuthService and add tests");
    expect(frame.intent).toBe("debug_and_fix");
    expect(frame.entities.paths).toContain("src/app.ts");
    expect(frame.entities.symbols).toContain("AuthService");
    expect(frame.needsTests).toBe(true);
  });
});
