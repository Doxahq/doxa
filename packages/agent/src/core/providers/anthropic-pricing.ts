import { anthropicModelPrice as lookupAnthropicModelPrice } from "@doxahq/contracts/model-prices";
import type { ModelPriceLookup } from "../pricing";

/**
 * Anthropic list prices. Anthropic sends no cost with a response, so usage
 * records take it from here. The table lives in `@doxahq/contracts/model-prices`
 * so that billing admission can refuse a run whose model has no price
 * (billing spec 10.5) with the same table. Update the table there when the
 * pricing page changes.
 */

/** Matches a model ID or a dated snapshot of it, such as `claude-haiku-4-5-20251001`. */
export const anthropicModelPrice: ModelPriceLookup = (model) => lookupAnthropicModelPrice(model);
