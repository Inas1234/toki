import { describe, expect, test } from "vitest";
import { buildPrompt } from "../src/core/orchestrator/promptBuilder.js";

describe("buildPrompt", () => {
  test("uses the cleaned task objective instead of raw transcript noise", () => {
    const prompt = buildPrompt({
      task: {
        raw: ["TOOLING(.)", "READ(README.md)", "", "implement it"].join("\n"),
        objective: "Why does edit recovery lose context and how should it be fixed?\nimplement it",
        intent: "debug_and_fix",
        entities: {
          paths: [],
          symbols: [],
          errors: [],
          domains: ["engine", "tool", "context"]
        },
        risk: "low",
        needsEdit: true,
        needsTests: true,
        confidence: 0.9
      },
      phase: {
        id: "implement",
        name: "Implement",
        goal: "Patch the bug",
        status: "active",
        entryCriteria: [],
        exitCriteria: [],
        expectedArtifacts: [],
        maxContextMode: "normal"
      },
      checkpoint: {
        task: "Patch the bug",
        phase: "Implement",
        completed: [],
        filesChanged: [],
        decisions: [],
        currentState: "working",
        nextSteps: [],
        knownIssues: [],
        commandsRun: []
      },
      receipt: {
        turn: 1,
        mode: "normal",
        ceiling: 4000,
        usedTokens: 100,
        savedTokens: 50,
        loaded: [],
        skipped: [],
        compressed: []
      },
      selectedContext: [],
      repoRules: "",
      pinnedContext: [],
      toolResults: "(none)",
      instructions: "Fix the bug.",
      successCriteria: "Return the most useful next response for this turn."
    });

    expect(prompt).toContain("objective: Why does edit recovery lose context and how should it be fixed?");
    expect(prompt).toContain("implement it");
    expect(prompt).not.toContain("raw: TOOLING(.)");
    expect(prompt).not.toContain("READ(README.md)");
  });
});
