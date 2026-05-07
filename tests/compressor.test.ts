import { describe, expect, test } from "vitest";
import { Compressor } from "../src/core/compressor/compressor.js";

describe("Compressor", () => {
  test("compresses long tool output to useful lines", () => {
    const compressor = new Compressor();
    const raw = Array.from({ length: 300 }, (_, i) => `line ${i}`)
      .concat(["ERROR: failing test A", "at src/a.ts:10:3", "PASS 1 test"])
      .join("\n");
    const result = compressor.compressToolOutput(raw, 120);
    expect(result.toTokens).toBeLessThanOrEqual(120);
    expect(result.content.toLowerCase()).toContain("error");
  });
});
