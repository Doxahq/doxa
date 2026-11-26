import { describe, expect, it } from "vitest";

import {
  CatalogError,
  DOXA_CATALOG,
  FEATURE_KEYS,
  LIMIT_KEYS,
  PLAN_KEYS,
  UNLIMITED,
  defineCatalog,
  describeOffer,
  findCatalogProblems,
  formatUsd,
  monthlyEquivalentCents,
  yearlySavingsPercent,
  type Catalog,
} from "../src/catalog/index";

/** A deep copy that a test may break. */
function mutable(): { -readonly [K in keyof Catalog]: Catalog[K] } & Record<string, unknown> {
  return structuredClone(DOXA_CATALOG) as never;
}

describe("the Doxa catalog", () => {
  it("passes every defineCatalog check", () => {
    expect(findCatalogProblems(DOXA_CATALOG)).toEqual([]);
  });

  it("lists every feature and limit key on every plan", () => {
    for (const plan of PLAN_KEYS) {
      expect(Object.keys(DOXA_CATALOG.plans[plan].features).sort()).toEqual([...FEATURE_KEYS].sort());
      expect(Object.keys(DOXA_CATALOG.plans[plan].limits).sort()).toEqual([...LIMIT_KEYS].sort());
    }
  });

  it("has positive integer prices, unique keys, and a price for every self-serve paid plan", () => {
    for (const price of Object.values(DOXA_CATALOG.prices)) {
      expect(Number.isSafeInteger(price.amountCents) && price.amountCents > 0).toBe(true);
    }
    const keys = [...Object.keys(DOXA_CATALOG.prices), ...Object.keys(DOXA_CATALOG.usagePrices), ...Object.keys(DOXA_CATALOG.offers)];
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.values(DOXA_CATALOG.prices).some((price) => price.plan === "pro")).toBe(true);
  });

  it("gives Free 0 credits and Pro 10,000 credits a month", () => {
    expect(DOXA_CATALOG.plans.free.limits["ai.credits_monthly"]).toBe(0);
    expect(DOXA_CATALOG.plans.pro.limits["ai.credits_monthly"]).toBe(10_000);
    expect(DOXA_CATALOG.plans.pro.trial).toEqual({ days: 7, credits: 1_000, requiresPaymentMethod: true });
  });

  it("pairs each Pro price with a usage price of the same interval", () => {
    for (const price of Object.values(DOXA_CATALOG.prices)) {
      expect(DOXA_CATALOG.usagePrices[price.usage]?.interval).toBe(price.interval);
    }
  });

  it("keeps the pay-as-you-go rules consistent", () => {
    const payg = DOXA_CATALOG.payg;
    expect(payg.chargeAtCredits).toBeLessThanOrEqual(payg.maxDebtCredits);
    expect(payg.sweepMinCredits).toBeGreaterThanOrEqual(50);
    expect(payg.defaultMonthlyLimitCents).toBeGreaterThanOrEqual(payg.monthlyLimitRangeCents[0]);
    expect(payg.defaultMonthlyLimitCents).toBeLessThanOrEqual(payg.monthlyLimitRangeCents[1]);
  });

  it("has base <= minCap <= defaultCap <= maxCap and a markup of at least 1", () => {
    expect(DOXA_CATALOG.usage.markup).toBeGreaterThanOrEqual(1);
    for (const action of Object.values(DOXA_CATALOG.actions)) {
      if (action.pricing.kind !== "metered") continue;
      const { base, minCap, defaultCap, maxCap } = action.pricing;
      for (const value of [base, minCap, defaultCap, maxCap]) expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
      expect(base).toBeLessThanOrEqual(minCap);
      expect(minCap).toBeLessThanOrEqual(defaultCap);
      expect(defaultCap).toBeLessThanOrEqual(maxCap);
    }
  });

  it("points each offer at existing prices, with a then price for each interval", () => {
    for (const offer of Object.values(DOXA_CATALOG.offers)) {
      for (const interval of ["month", "year"] as const) {
        expect(DOXA_CATALOG.prices[offer.prices[interval]]?.interval).toBe(interval);
        expect(DOXA_CATALOG.prices[offer.then[interval]]?.interval).toBe(interval);
      }
    }
  });

  it("keeps the decided prices (D4, D14)", () => {
    expect(DOXA_CATALOG.prices.pro_monthly_founder_v2.amountCents).toBe(12_900);
    expect(DOXA_CATALOG.prices.pro_yearly_founder_v2.amountCents).toBe(99 * 12 * 100);
    expect(DOXA_CATALOG.prices.pro_monthly_v1.amountCents).toBe(20_900);
    expect(DOXA_CATALOG.prices.pro_yearly_v1.amountCents).toBe(169 * 12 * 100);
    expect(DOXA_CATALOG.offers.founder_v1.maxAccounts).toBe(50);
    expect(DOXA_CATALOG.offers.founder_v1.prices).toEqual({ month: "pro_monthly_founder_v2", year: "pro_yearly_founder_v2" });
  });

  it("keeps the founder v1 prices for their customers, closed to new Checkouts", () => {
    expect(DOXA_CATALOG.prices.pro_monthly_founder_v1).toMatchObject({ amountCents: 15_900, availableForNewCustomers: false });
    expect(DOXA_CATALOG.prices.pro_yearly_founder_v1).toMatchObject({ amountCents: 129 * 12 * 100, availableForNewCustomers: false });
  });

  it("uses a branded UNLIMITED that survives JSON", () => {
    const roundTrip = JSON.parse(JSON.stringify(DOXA_CATALOG.plans.pro.limits)) as Record<string, unknown>;
    expect(roundTrip["team.seats"]).toBe(UNLIMITED);
  });
});

describe("defineCatalog refuses", () => {
  const refuses = (change: (catalog: ReturnType<typeof mutable>) => void, message: RegExp) => {
    const catalog = mutable();
    change(catalog);
    expect(() => defineCatalog(catalog as Catalog)).toThrow(CatalogError);
    expect(findCatalogProblems(catalog as Catalog).join("\n")).toMatch(message);
  };

  it("an unknown or invalid past-due limit", () => {
    refuses((catalog) => {
      (catalog.subscriptions as { pastDueLimits: Record<string, unknown> }).pastDueLimits = { "docs.nope": 1 };
    }, /pastDueLimits has an unknown limit docs\.nope/);
    refuses((catalog) => {
      (catalog.subscriptions as { pastDueLimits: Record<string, unknown> }).pastDueLimits = { "docs.export_window_hours": -1 };
    }, /pastDueLimits\.docs\.export_window_hours must be/);
  });

  it("a live action with unset pricing", () => {
    refuses((catalog) => {
      (catalog.actions as Record<string, { status: string }>)["docs_chat.answer"]!.status = "live";
    }, /live action docs_chat.answer cannot have unset pricing/);
  });

  it("a live docs chat without a per-site daily cap", () => {
    refuses((catalog) => {
      const actions = catalog.actions as Record<string, unknown>;
      actions["docs_chat.answer"] = {
        status: "live",
        feature: "ai.docs_chat",
        pricing: { kind: "flat", credits: 5, charge: { answered: "base+usage", no_answer: "none", failed: "none" } },
        perSiteDailyCapCredits: null,
      };
    }, /needs perSiteDailyCapCredits/);
  });

  it("no Free team for a team owner (a new team starts on Free)", () => {
    refuses((catalog) => {
      (catalog.teams as { freeTeamsPerOwner: number }).freeTeamsPerOwner = 0;
    }, /teams\.freeTeamsPerOwner must be a positive integer/);
  });

  it("a missing limit key", () => {
    refuses((catalog) => {
      delete (catalog.plans.free.limits as Record<string, unknown>)["team.seats"];
    }, /does not list limit team.seats/);
  });

  it("a Pro price with a usage price of another interval", () => {
    refuses((catalog) => {
      (catalog.prices as Record<string, { usage: string }>).pro_monthly_v1!.usage = "ai_usage_yearly_v1";
    }, /same interval/);
  });

  it("base above the default cap", () => {
    refuses((catalog) => {
      (catalog.actions["generation.run"].pricing as { base: number }).base = 4_000;
    }, /base <= minCap <= defaultCap <= maxCap/);
  });

  it("a minimum cap below the base fee", () => {
    refuses((catalog) => {
      (catalog.actions["generation.run"].pricing as { minCap: number }).minCap = 10;
    }, /base <= minCap <= defaultCap <= maxCap/);
  });

  it("a markup below 1 and a sweep below 50", () => {
    refuses((catalog) => {
      (catalog.usage as { markup: number }).markup = 0.5;
      (catalog.payg as { sweepMinCredits: number }).sweepMinCredits = 10;
    }, /sweepMinCredits must be >= 50[\s\S]*markup must be at least 1/);
  });

  it("Free with credits, and a price key without a version", () => {
    refuses((catalog) => {
      (catalog.plans.free.limits as Record<string, unknown>)["ai.credits_monthly"] = 10;
      (catalog.prices as Record<string, unknown>).pro_forever = { plan: "pro", interval: "month", amountCents: 1, usage: "ai_usage_monthly_v1" };
    }, /free must have 0 monthly credits[\s\S]*pro_forever must end with a version/);
  });
});

describe("price display helpers", () => {
  it("formats USD and the yearly saving of the pricing page", () => {
    expect(formatUsd(15_900)).toBe("$159");
    expect(formatUsd(150)).toBe("$1.50");
    expect(monthlyEquivalentCents(DOXA_CATALOG.prices.pro_yearly_founder_v2)).toBe(9_900);
    expect(yearlySavingsPercent(DOXA_CATALOG.prices.pro_monthly_founder_v2, DOXA_CATALOG.prices.pro_yearly_founder_v2)).toBe(23);
    expect(yearlySavingsPercent(DOXA_CATALOG.prices.pro_monthly_v1, DOXA_CATALOG.prices.pro_yearly_v1)).toBe(19);
  });

  it("describes the founder offer open, and closed with the then prices", () => {
    const open = describeOffer(DOXA_CATALOG, "founder_v1", 12);
    expect(open).toMatchObject({ open: true, slotsLeft: 38, prices: { year: { priceKey: "pro_yearly_founder_v2", monthlyEquivalentCents: 9_900 } } });
    const closed = describeOffer(DOXA_CATALOG, "founder_v1", 50);
    expect(closed).toMatchObject({ open: false, slotsLeft: 0, prices: { month: { priceKey: "pro_monthly_v1" }, year: { priceKey: "pro_yearly_v1" } } });
  });
});
