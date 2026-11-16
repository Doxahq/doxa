import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * `packages/contracts/src/model-prices.ts`: the table the meter charges from
 * (spec 7.2). The agent's `anthropic-pricing.ts` and billing admission both
 * read it there.
 */
export const MODEL_PRICE_FILE = fileURLToPath(new URL("../../../contracts/src/model-prices.ts", import.meta.url));

/** The `ANTHROPIC_MODEL_PRICES` object literal and the `prices()` helper, without comments or whitespace. */
export function modelPriceTableSource(): string {
  const text = readFileSync(MODEL_PRICE_FILE, "utf8");
  const helper = /function prices\([\s\S]*?\n}\n/.exec(text)?.[0];
  const table = /const ANTHROPIC_MODEL_PRICES[\s\S]*?\n};\n/.exec(text)?.[0];
  if (!helper || !table) throw new Error(`The model price table moved: update tests/helpers/model-price-table.ts (${MODEL_PRICE_FILE}).`);
  return `${helper}${table}`.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, "");
}

export function modelPriceTableHash(): string {
  return createHash("sha256").update(modelPriceTableSource()).digest("hex");
}

/** The model IDs that have a price. */
export function pricedModelIds(): string[] {
  const table = /const ANTHROPIC_MODEL_PRICES[\s\S]*?\n};\n/.exec(readFileSync(MODEL_PRICE_FILE, "utf8"))?.[0] ?? "";
  return [...table.matchAll(/^\s+"([a-z0-9.-]+)":/gm)].map((match) => match[1] ?? "");
}
