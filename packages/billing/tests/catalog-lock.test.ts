import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DOXA_CATALOG, IMMUTABLE_PRICE_MESSAGE, buildCatalogLock, diffCatalogLock, type CatalogLock } from "../src/catalog/index";
import { modelPriceTableHash } from "./helpers/model-price-table";

const LOCK_FILE = fileURLToPath(new URL("../catalog.lock.json", import.meta.url));

/**
 * `BILLING_WRITE_CATALOG_LOCK=1 pnpm --filter @doxahq/billing test catalog-lock`
 * writes the lock for a new key or a markup, base fee or model table change.
 * It never writes over a changed existing price.
 */
describe("catalog.lock.json", () => {
  const current = buildCatalogLock(DOXA_CATALOG, modelPriceTableHash());

  it("matches the catalog: prices are immutable", () => {
    if (!existsSync(LOCK_FILE) && process.env.BILLING_WRITE_CATALOG_LOCK === "1") {
      writeFileSync(LOCK_FILE, `${JSON.stringify(current, null, 2)}\n`);
    }
    const locked = JSON.parse(readFileSync(LOCK_FILE, "utf8")) as CatalogLock;
    const diff = diffCatalogLock(locked, current);
    expect(diff.immutableViolations, IMMUTABLE_PRICE_MESSAGE).toEqual([]);
    if (diff.needsLockUpdate.length > 0 && process.env.BILLING_WRITE_CATALOG_LOCK === "1") {
      writeFileSync(LOCK_FILE, `${JSON.stringify(current, null, 2)}\n`);
      return;
    }
    expect(
      diff.needsLockUpdate,
      "A pricing change: update catalog.lock.json in the same change (BILLING_WRITE_CATALOG_LOCK=1) and say in the pull request which customer charges change.",
    ).toEqual([]);
  });

  it("refuses a changed amount on an existing key", () => {
    const changed = buildCatalogLock(
      { ...DOXA_CATALOG, prices: { ...DOXA_CATALOG.prices, pro_monthly_v1: { ...DOXA_CATALOG.prices.pro_monthly_v1, amountCents: 19_900 } } },
      current.modelPriceTableHash,
    );
    const diff = diffCatalogLock(current, changed);
    expect(diff.immutableViolations.join("\n")).toContain("Prices are immutable. Add a new price version.");
  });

  it("asks for a lock update on a markup or model table change", () => {
    const changed = buildCatalogLock({ ...DOXA_CATALOG, usage: { ...DOXA_CATALOG.usage, markup: 4 } }, "other-hash");
    const diff = diffCatalogLock(current, changed);
    expect(diff.immutableViolations).toEqual([]);
    expect(diff.needsLockUpdate).toEqual(["markup changed from 3 to 4", "the model price table changed"]);
  });
});
