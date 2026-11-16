import { MB, UNLIMITED, defineCatalog, featuresExcept } from "./define";

/**
 * THE Doxa catalog: plans, prices, usage prices, offers, pay-as-you-go, base
 * fees, markup and caps. Read `packages/billing/AGENTS.md` before you change it.
 * Never change the amount of an existing price key: add a new version.
 */
export const DOXA_CATALOG = defineCatalog({
  version: 1,
  currency: "usd",
  credit: { unitPriceCents: 1 },

  plans: {
    free: {
      name: "Free",
      selfServe: true,
      hosting: "shared",
      enforceCredits: true,
      features: {
        "ai.doxa_agent": false,
        "ai.doxabot": false,
        "ai.docs_chat": false,
        "ai.payg": false,
        "docs.publish_approvals": false,
        "site.remove_powered_by": false,
        "site.typesense_search": false,
        "team.role_permissions": false,
        "agents.approval_rules": false,
      },
      limits: {
        "ai.credits_monthly": 0,
        "docs.branches_per_site": 3,
        "docs.storage_bytes": 100 * MB,
        "site.asset_bytes": 50 * MB,
        "site.asset_files": 200,
        "site.custom_domains": 1,
        "team.seats": 1,
        "mcp.tool_calls_per_day": 100,
      },
    },
    pro: {
      name: "Pro",
      selfServe: true,
      hosting: "dedicated",
      enforceCredits: true,
      features: featuresExcept("agents.approval_rules"),
      limits: {
        "ai.credits_monthly": 5_000,
        "docs.branches_per_site": UNLIMITED,
        "docs.storage_bytes": UNLIMITED,
        // Decided 2026-11-14: Pro site assets are unlimited, like "Unlimited docs storage" on the pricing page.
        "site.asset_bytes": UNLIMITED,
        "site.asset_files": UNLIMITED,
        "site.custom_domains": 4,
        "team.seats": UNLIMITED,
        "mcp.tool_calls_per_day": UNLIMITED,
      },
      trial: { days: 7, credits: 1_000, requiresPaymentMethod: true }, // decision D3
    },
    enterprise: {
      name: "Enterprise",
      selfServe: false,
      hosting: "dedicated",
      enforceCredits: true,
      features: featuresExcept(),
      limits: {
        "ai.credits_monthly": 50_000, // the contract sets the real value with an override
        "docs.branches_per_site": UNLIMITED,
        "docs.storage_bytes": UNLIMITED,
        "site.asset_bytes": UNLIMITED,
        "site.asset_files": UNLIMITED,
        "site.custom_domains": UNLIMITED,
        "team.seats": UNLIMITED,
        "mcp.tool_calls_per_day": UNLIMITED,
      },
    },
    self_hosted: {
      name: "Self-hosted",
      selfServe: false,
      hosting: "dedicated",
      enforceCredits: false,
      features: featuresExcept(),
      limits: {
        "ai.credits_monthly": UNLIMITED,
        "docs.branches_per_site": UNLIMITED,
        "docs.storage_bytes": UNLIMITED,
        "site.asset_bytes": UNLIMITED,
        "site.asset_files": UNLIMITED,
        "site.custom_domains": UNLIMITED,
        "team.seats": UNLIMITED,
        "mcp.tool_calls_per_day": UNLIMITED,
      },
    },
  },

  // `usage` names the usage price that goes into the same Checkout. It has the
  // same interval, because Checkout refuses mixed intervals (section 10.10).
  prices: {
    pro_monthly_founder_v1: { plan: "pro", interval: "month", amountCents: 15_900, usage: "ai_usage_monthly_v1" },
    pro_yearly_founder_v1: { plan: "pro", interval: "year", amountCents: 154_800, usage: "ai_usage_yearly_v1" }, // $129 x 12
    pro_monthly_v1: { plan: "pro", interval: "month", amountCents: 20_900, usage: "ai_usage_monthly_v1" }, // decision D14
    pro_yearly_v1: { plan: "pro", interval: "year", amountCents: 202_800, usage: "ai_usage_yearly_v1" }, // $169 x 12
  },

  // Metered prices on the provider meter `doxa_ai_overage`, $0.01 for each credit.
  usagePrices: {
    ai_usage_monthly_v1: { interval: "month", unitAmountCents: 1, meter: "doxa_ai_overage" },
    ai_usage_yearly_v1: { interval: "year", unitAmountCents: 1, meter: "doxa_ai_overage" },
  },

  // Section 7.5. When the founder offer is full, new Checkouts use `then`.
  offers: {
    founder_v1: {
      label: "Founder price",
      maxAccounts: 50,
      prices: { month: "pro_monthly_founder_v1", year: "pro_yearly_founder_v1" },
      then: { month: "pro_monthly_v1", year: "pro_yearly_v1" },
    },
  },

  // Section 10.10. Decisions D16, D17 and D18 (no credit packs in v1).
  payg: {
    defaultOn: true, // for paid accounts
    duringTrial: false,
    chargeAtCredits: 500, // $5: the provider billing threshold
    maxDebtCredits: 1_000, // $10: runs stop here
    defaultMonthlyLimitCents: 3_000, // $30: the user can change it
    monthlyLimitRangeCents: [500, 20_000], // $5–$200 at launch, raise later
    sweepMinCredits: 50, // $0.50: the provider threshold minimum
  },

  // Section 10.5. One markup for every model. Decision D11.
  usage: { markup: 3, extendStepCredits: 250 },

  subscriptions: { pastDueGraceDays: 7 }, // decision D5

  actions: {
    "generation.run": {
      status: "live",
      feature: "ai.doxa_agent",
      pricing: {
        kind: "metered",
        base: 50, // decision D11
        minCap: 1_000, // 350 on 2026-11-16, 1,000 the same day
        defaultCap: 3_000, // decision D13
        maxCap: 10_000,
        inFlightMarginCredits: 300,
        defaultEstimateCredits: 400,
        charge: { succeeded: "base+usage", stopped: "base+usage", cancelled: "base+usage", failed: "none" },
      },
    },
    "doxabot.run": {
      status: "live",
      feature: "ai.doxabot",
      pricing: {
        kind: "metered",
        base: 20,
        minCap: 500, // 120 on 2026-11-16, 500 the same day
        defaultCap: 500,
        maxCap: 10_000,
        inFlightMarginCredits: 100,
        defaultEstimateCredits: 200,
        charge: {
          pages_changed: "base+usage",
          no_change: "usage", // decision D12
          superseded: "usage",
          stopped: "base+usage",
          cancelled: "base+usage",
          failed: "none",
        },
      },
    },
    // Section 10.9. Planned: the pricing page hides it and entitlements deny it.
    "docs_chat.answer": {
      status: "planned",
      feature: "ai.docs_chat",
      pricing: { kind: "unset", charge: { answered: "base+usage", no_answer: "none", failed: "none" } },
      perSiteDailyCapCredits: null, // must be set before the status is "live"
    },
    "mcp.tool_call": { status: "live", pricing: { kind: "free" } },
  },

  safety: {
    maxDailyModelCostUsdPerAccount: 75, // internal stop, see section 19
  },
});

export type DoxaCatalog = typeof DOXA_CATALOG;
export type PriceKey = keyof DoxaCatalog["prices"];
export type UsagePriceKey = keyof DoxaCatalog["usagePrices"];
export type OfferKey = keyof DoxaCatalog["offers"];
/** The outcomes that the charge rules of one action name, such as `succeeded` or `no_change`. */
export type ActionOutcome<A extends keyof DoxaCatalog["actions"]> = DoxaCatalog["actions"][A]["pricing"] extends {
  charge: infer C;
}
  ? Extract<keyof C, string>
  : never;
