/**
 * The keys that code checks. A new feature or limit key needs an enforcement
 * point and a test in the same change (spec section 9.3).
 *
 * Price, usage price and offer keys come from the catalog file itself
 * (`doxa.ts`), so a new price version is a change to that one file.
 */

export const PLAN_KEYS = ["free", "pro", "enterprise", "self_hosted"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export const FEATURE_KEYS = [
  "ai.doxa_agent",
  "ai.doxabot",
  "ai.docs_chat",
  "ai.payg",
  "docs.publish_approvals",
  "site.remove_powered_by",
  "site.typesense_search",
  "team.role_permissions",
  "agents.approval_rules",
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const LIMIT_KEYS = [
  "ai.credits_monthly",
  "docs.branches_per_site",
  "docs.storage_bytes",
  "site.asset_bytes",
  "site.asset_files",
  "site.custom_domains",
  "team.seats",
  "mcp.tool_calls_per_day",
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

export const ACTION_KEYS = ["generation.run", "doxabot.run", "docs_chat.answer", "mcp.tool_call"] as const;
export type ActionKey = (typeof ACTION_KEYS)[number];

/** The AI features. A past-due account past its grace period loses these (spec 9.1). */
export const AI_FEATURE_KEYS = ["ai.doxa_agent", "ai.doxabot", "ai.docs_chat", "ai.payg"] as const satisfies readonly FeatureKey[];

/** Daily quota meters and the limit key that sets each one (spec section 11). */
export const QUOTA_METERS = {
  "mcp.tool_calls": "mcp.tool_calls_per_day",
} as const satisfies Record<string, LimitKey>;
export type QuotaMeterKey = keyof typeof QUOTA_METERS;

export const BILLING_INTERVALS = ["month", "year"] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export const HOSTING_TIERS = ["shared", "dedicated"] as const;
export type HostingTier = (typeof HOSTING_TIERS)[number];

export function isPlanKey(value: string): value is PlanKey {
  return (PLAN_KEYS as readonly string[]).includes(value);
}

export function isFeatureKey(value: string): value is FeatureKey {
  return (FEATURE_KEYS as readonly string[]).includes(value);
}

export function isLimitKey(value: string): value is LimitKey {
  return (LIMIT_KEYS as readonly string[]).includes(value);
}

export function isActionKey(value: string): value is ActionKey {
  return (ACTION_KEYS as readonly string[]).includes(value);
}
