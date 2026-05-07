import { encoding_for_model, get_encoding, Tiktoken } from "tiktoken";

let encoder: Tiktoken | null = null;

function getEncoder(model = "gpt-4o-mini"): Tiktoken {
  if (encoder) {
    return encoder;
  }
  try {
    encoder = encoding_for_model(model as never);
    return encoder;
  } catch {
    encoder = get_encoding("cl100k_base");
    return encoder;
  }
}

export function estimateTokens(text: string, model?: string): number {
  if (text.trim().length === 0) {
    return 0;
  }
  try {
    return getEncoder(model).encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}
