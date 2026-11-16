import type { Catalog } from "./define";

/**
 * The committed snapshot in `catalog.lock.json` (spec section 7.2). Every
 * price key and amount, the markup, the base fees, and a hash of the model
 * price table. A change to any of these is a visible pricing change.
 */
export interface CatalogLock {
  readonly prices: Readonly<Record<string, { readonly plan: string; readonly interval: string; readonly amountCents: number; readonly usage: string }>>;
  readonly usagePrices: Readonly<Record<string, { readonly interval: string; readonly unitAmountCents: number; readonly meter: string }>>;
  readonly markup: number;
  readonly baseFees: Readonly<Record<string, number>>;
  readonly modelPriceTableHash: string;
}

export const IMMUTABLE_PRICE_MESSAGE = "Prices are immutable. Add a new price version.";

export function buildCatalogLock(catalog: Catalog, modelPriceTableHash: string): CatalogLock {
  const sorted = <T>(record: Readonly<Record<string, T>>) =>
    Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  const baseFees: Record<string, number> = {};
  for (const [key, action] of Object.entries(catalog.actions)) {
    if (action.pricing.kind === "metered") baseFees[key] = action.pricing.base;
    if (action.pricing.kind === "flat") baseFees[key] = action.pricing.credits;
  }
  return {
    prices: sorted(
      Object.fromEntries(
        Object.entries(catalog.prices).map(([key, price]) => [
          key,
          { plan: price.plan, interval: price.interval, amountCents: price.amountCents, usage: price.usage },
        ]),
      ),
    ),
    usagePrices: sorted(
      Object.fromEntries(
        Object.entries(catalog.usagePrices).map(([key, usage]) => [
          key,
          { interval: usage.interval, unitAmountCents: usage.unitAmountCents, meter: usage.meter },
        ]),
      ),
    ),
    markup: catalog.usage.markup,
    baseFees: sorted(baseFees),
    modelPriceTableHash,
  };
}

export interface CatalogLockDiff {
  /** An existing key changed or disappeared. Never allowed. */
  readonly immutableViolations: readonly string[];
  /** New keys, a markup, base fee or model table change: allowed with a lock update in the same change. */
  readonly needsLockUpdate: readonly string[];
}

export function diffCatalogLock(locked: CatalogLock, current: CatalogLock): CatalogLockDiff {
  const immutableViolations: string[] = [];
  const needsLockUpdate: string[] = [];
  for (const table of ["prices", "usagePrices"] as const) {
    const lockedTable: Readonly<Record<string, object>> = locked[table];
    const currentTable: Readonly<Record<string, object>> = current[table];
    for (const [key, value] of Object.entries(lockedTable)) {
      const now = currentTable[key];
      if (!now) immutableViolations.push(`${table}.${key} was removed. ${IMMUTABLE_PRICE_MESSAGE}`);
      else if (JSON.stringify(now) !== JSON.stringify(value)) {
        immutableViolations.push(`${table}.${key} changed from ${JSON.stringify(value)} to ${JSON.stringify(now)}. ${IMMUTABLE_PRICE_MESSAGE}`);
      }
    }
    for (const key of Object.keys(currentTable)) {
      if (!(key in lockedTable)) needsLockUpdate.push(`new ${table} key ${key}`);
    }
  }
  if (locked.markup !== current.markup) needsLockUpdate.push(`markup changed from ${locked.markup} to ${current.markup}`);
  if (JSON.stringify(locked.baseFees) !== JSON.stringify(current.baseFees)) {
    needsLockUpdate.push(`base fees changed from ${JSON.stringify(locked.baseFees)} to ${JSON.stringify(current.baseFees)}`);
  }
  if (locked.modelPriceTableHash !== current.modelPriceTableHash) needsLockUpdate.push("the model price table changed");
  return { immutableViolations, needsLockUpdate };
}
