import { compactWhitespace, estimateTokens } from "@toki/shared";

export interface CompressionResult {
  content: string;
  fromTokens: number;
  toTokens: number;
  method: string;
}

function keepUsefulLines(lines: string[]): string[] {
  return lines.filter((line) => {
    const lower = line.toLowerCase();
    if (lower.trim().length === 0) {
      return false;
    }
    return (
      /\b(error|fail|warning|passed|failed|test|trace|exception|assert)\b/.test(lower) ||
      /^\s*(>|\$|at\s|#)/.test(line)
    );
  });
}

export class Compressor {
  public compressToolOutput(raw: string, maxTokens = 1200): CompressionResult {
    const fromTokens = estimateTokens(raw);
    if (fromTokens <= maxTokens) {
      return {
        content: compactWhitespace(raw),
        fromTokens,
        toTokens: fromTokens,
        method: "none"
      };
    }
    const lines = raw.split(/\r?\n/);
    const focused = keepUsefulLines(lines);
    const picked = focused.length > 0 ? focused : lines.slice(-120);
    let content = compactWhitespace(picked.join("\n"));
    let toTokens = estimateTokens(content);

    if (toTokens > maxTokens) {
      const approxChars = maxTokens * 4;
      content = `${content.slice(0, approxChars)}\n...[truncated]`;
      toTokens = estimateTokens(content);
    }

    return {
      content,
      fromTokens,
      toTokens,
      method: "signal_lines"
    };
  }

  public compressHistory(messages: Array<{ role: string; content: string }>, maxTokens = 1800): CompressionResult {
    const serialized = messages.map((msg) => `${msg.role}: ${msg.content}`).join("\n");
    const fromTokens = estimateTokens(serialized);
    if (fromTokens <= maxTokens) {
      return {
        content: serialized,
        fromTokens,
        toTokens: fromTokens,
        method: "none"
      };
    }
    const keep = messages.slice(-8);
    const condensed = keep
      .map((item) => `${item.role}: ${compactWhitespace(item.content).slice(0, 480)}`)
      .join("\n");
    return {
      content: condensed,
      fromTokens,
      toTokens: estimateTokens(condensed),
      method: "tail_window"
    };
  }
}
