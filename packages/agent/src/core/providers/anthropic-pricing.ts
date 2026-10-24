import type { ModelPrice, ModelPriceLookup, TokenPrices } from "../pricing";

/**
 * Anthropic list prices in USD per million tokens, from
 * https://platform.claude.com/docs/en/about-claude/pricing (read 2026-10-16).
 * Anthropic sends no cost with a response, so usage records take it from here.
 * Update this table when the pricing page changes.
 */
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

const ANTHROPIC_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
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
const MODEL_ID_PREFIXES = Object.keys(ANTHROPIC_MODEL_PRICES)
  .sort((a, b) => b.length - a.length);

/** Matches a model ID or a dated snapshot of it, such as `claude-haiku-4-5-20251001`. */
export const anthropicModelPrice: ModelPriceLookup = (model) => {
  const prefix = MODEL_ID_PREFIXES.find(
    (candidate) => model === candidate || model.startsWith(`${candidate}-`),
  );
  return prefix ? ANTHROPIC_MODEL_PRICES[prefix] : undefined;
};
