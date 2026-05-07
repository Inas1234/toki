import { describe, expect, test } from "vitest";
import { ContextLedger } from "../src/core/ledger/ledger.js";
import { ContextReceipt } from "../src/core/types.js";

describe("ContextLedger", () => {
  test("records and explains loaded/skipped files", () => {
    const ledger = new ContextLedger();
    const receipt: ContextReceipt = {
      turn: 1,
      mode: "normal",
      ceiling: 12000,
      usedTokens: 1000,
      savedTokens: 3000,
      loaded: [
        {
          id: "a",
          type: "file",
          path: "src/a.ts",
          representation: "symbols",
          content: "x",
          estimatedTokens: 20,
          relevanceScore: 0.8,
          freshness: 1,
          source: "src/a.ts",
          reason: "symbol match",
          priority: 90
        }
      ],
      skipped: [{ path: "src/b.ts", reason: "budget", estimatedTokens: 100 }],
      compressed: []
    };
    ledger.record(receipt);
    expect(ledger.explainPath("src/a.ts")).toContain("loaded");
    expect(ledger.explainPath("src/b.ts")).toContain("skipped");
  });
});
