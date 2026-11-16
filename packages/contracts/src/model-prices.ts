import type { ModelProvider } from "./model-providers";
import { stableStringify } from "./stable-hash";

/**
 * Anthropic list prices in USD per million tokens, from
 * https://platform.claude.com/docs/en/about-claude/pricing (read 2026-10-16).
 * Anthropic sends no cost with a response, so usage records take it from here
 * (`packages/agent/src/core/providers/anthropic-pricing.ts`). Billing admission
 * refuses a run whose model has no entry (billing spec 10.5 step 7), and each
 * credit settle stores `MODEL_PRICE_TABLE_HASH` (spec 10.8). Update this table
 * when the pricing page changes.
 */
export interface TokenPrices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: Record<"5m" | "1h", number>;
}

export interface ModelPrice extends TokenPrices {
  /** Higher prices for a request whose whole prompt is over the threshold. */
  longPrompt?: {
    aboveInputTokens: number;
    prices: TokenPrices;
  };
}

function prices(
  input: number,
  cacheWrite5m: number,
  cacheWrite1h: number,
  cacheRead: number,
  output: number,
): TokenPrices {
  return {
    input,
    output,
    cacheRead,
    cacheWrite: { "5m": cacheWrite5m, "1h": cacheWrite1h },
  };
}

export const ANTHROPIC_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-1": prices(10, 12.5, 20, 0.25, 50),
  "claude-opus-5-5": prices(4, 5, 8, 0.2, 20),
  "claude-opus-5": prices(5, 6.25, 10, 0.5, 25),
  "claude-sonnet-5-5": prices(2, 2.5, 4, 0.1, 10),
  "claude-sonnet-5": prices(2, 2.5, 4, 0.2, 10),
  "claude-sonnet-4-6": prices(3, 3.75, 6, 0.3, 15),
  "claude-sonnet-4-5": prices(3, 3.75, 6, 0.3, 15),
  "claude-haiku-5-5": {
    ...prices(0.1, 0.125, 0.2, 0.01, 0.5),
    longPrompt: {
      aboveInputTokens: 100_000,
      prices: prices(0.5, 0.625, 1, 0.05, 2.5),
    },
  },
  "claude-haiku-4-5": prices(1, 1.25, 2, 0.1, 5),
};

/** Longest first, so `claude-sonnet-5-5` never matches the `claude-sonnet-5` entry. */
const MODEL_ID_PREFIXES = Object.keys(ANTHROPIC_MODEL_PRICES).sort((a, b) => b.length - a.length);

/** Matches a model ID or a dated snapshot of it, such as `claude-haiku-4-5-20251001`. */
export function anthropicModelPrice(model: string): ModelPrice | undefined {
  const prefix = MODEL_ID_PREFIXES.find((candidate) => model === candidate || model.startsWith(`${candidate}-`));
  return prefix ? ANTHROPIC_MODEL_PRICES[prefix] : undefined;
}

/**
 * True when a usage record of this model gets a cost. OpenRouter reports the
 * cost of each call itself; Anthropic calls are priced from the table above.
 */
export function isModelPriced(provider: ModelProvider, model: string): boolean {
  if (provider === "openrouter") return true;
  return anthropicModelPrice(model) !== undefined;
}

/** FNV-1a over the table's stable JSON: a short, sync ID of the price table (billing spec 10.8). */
function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export const MODEL_PRICE_TABLE_HASH = `anthropic-${fnv1aHex(stableStringify(ANTHROPIC_MODEL_PRICES))}`;
