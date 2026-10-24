/**
 * Core Agent Library - Model pricing
 * Turns token usage into a USD cost from a provider's price table, for
 * providers that do not report a cost themselves.
 */

import type { PromptCacheTtl } from "./prompt-cache";
import type { TokenUsage } from "./types";

/** USD per million tokens. */
export interface TokenPrices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: Record<PromptCacheTtl, number>;
}

export interface ModelPrice extends TokenPrices {
  /** Higher prices for a request whose whole prompt is over the threshold. */
  longPrompt?: {
    aboveInputTokens: number;
    prices: TokenPrices;
  };
}

export type ModelPriceLookup = (model: string) => ModelPrice | undefined;

export interface UsageCost {
  cost: number;
  promptCost: number;
  completionCost: number;
}

const TOKENS_PER_PRICE_UNIT = 1_000_000;

/**
 * `usage.promptTokens` counts every input token, cache reads and cache
 * writes included. Cache writes are priced at the policy's lifetime.
 */
export function priceTokenUsage(
  price: ModelPrice,
  usage: TokenUsage,
  cacheTtl: PromptCacheTtl,
): UsageCost {
  const prices = pricesForPrompt(price, usage.promptTokens);
  const cacheRead = usage.cachedTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const uncachedInput = Math.max(0, usage.promptTokens - cacheRead - cacheWrite);
  const promptCost = perToken(uncachedInput, prices.input) +
    perToken(cacheRead, prices.cacheRead) +
    perToken(cacheWrite, prices.cacheWrite[cacheTtl]);
  const completionCost = perToken(usage.completionTokens, prices.output);
  return { cost: promptCost + completionCost, promptCost, completionCost };
}

/** Adds a cost from the price table when the provider sent none. */
export function withPricedCost(
  usage: TokenUsage,
  price: ModelPrice | undefined,
  cacheTtl: PromptCacheTtl,
): TokenUsage {
  if (usage.cost !== undefined || !price) return usage;
  return { ...usage, ...priceTokenUsage(price, usage, cacheTtl) };
}

function pricesForPrompt(price: ModelPrice, promptTokens: number): TokenPrices {
  return price.longPrompt && promptTokens > price.longPrompt.aboveInputTokens
    ? price.longPrompt.prices
    : price;
}

function perToken(tokens: number, pricePerMillion: number): number {
  return (tokens * pricePerMillion) / TOKENS_PER_PRICE_UNIT;
}
