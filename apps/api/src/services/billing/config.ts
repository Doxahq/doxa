import { readBillingConfig, type BillingConfig } from "@doxahq/billing";
import type { Env } from "../../env";

/**
 * The return base when neither `BILLING_RETURN_BASE_URL` nor `WEB_ORIGIN` is
 * set. Only Worker builds and tests get here: the Node origin requires
 * `WEB_ORIGIN` at start-up, and only the Node origin creates Checkout or
 * Portal links (billing spec 6.2).
 */
const FALLBACK_RETURN_BASE_URL = "http://localhost:3000";

export type BillingConfigEnv = Pick<
  Env,
  | "BILLING_PROVIDER"
  | "BILLING_ENFORCEMENT"
  | "BILLING_DEFAULT_PLAN"
  | "BILLING_RETURN_BASE_URL"
  | "STRIPE_SECRET_KEY"
  | "STRIPE_WEBHOOK_SECRET"
  | "STRIPE_MANAGED_PAYMENTS"
  | "WEB_ORIGIN"
>;

const KEYS = [
  "BILLING_PROVIDER",
  "BILLING_ENFORCEMENT",
  "BILLING_DEFAULT_PLAN",
  "BILLING_RETURN_BASE_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_MANAGED_PAYMENTS",
  "WEB_ORIGIN",
] as const satisfies readonly (keyof BillingConfigEnv)[];

/** The env of one process gives one config; requests build their env per scope, so key by value. */
let cached: { key: string; config: BillingConfig } | null = null;

/**
 * The billing settings (billing spec 6.3). The Node origin reads them once at
 * start-up (`createNodeEnv`), so a wrong value fails start-up there with
 * `BillingConfigurationError`. Worker builds read them on first use.
 */
export function billingConfigFor(source: BillingConfigEnv | undefined): BillingConfig {
  // Router tests may run a route without bindings: that is the default config.
  const env: BillingConfigEnv = source ?? {};
  const key = JSON.stringify(KEYS.map((name) => env[name] ?? null));
  if (cached?.key === key) return cached.config;
  const config = readBillingConfig(env, { dashboardUrl: env.WEB_ORIGIN ?? FALLBACK_RETURN_BASE_URL });
  cached = { key, config };
  return config;
}

/**
 * False with the defaults (`BILLING_PROVIDER=none`, `BILLING_ENFORCEMENT=off`):
 * then nothing outside the billing routes reads or writes the billing tables,
 * so production behaves as before billing until someone changes a setting.
 */
export function isBillingActive(config: Pick<BillingConfig, "provider" | "enforcement">): boolean {
  return config.provider !== "none" || config.enforcement !== "off";
}
