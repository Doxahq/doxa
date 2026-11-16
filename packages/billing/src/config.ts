import { z } from "zod";

import { PLAN_KEYS, type PlanKey } from "./catalog/keys";

/**
 * The settings of billing (spec 6.3). `readBillingConfig()` reads them once
 * at startup. A wrong value fails startup with `BillingConfigurationError`,
 * never a request. A new provider adds its settings here.
 */
export interface BillingEnv {
  /** `stripe`, `none` or `memory` (tests only: `NODE_ENV=test`). Default `none`. */
  BILLING_PROVIDER?: string;
  /** `off`, `shadow` or `on`. Default `off`. */
  BILLING_ENFORCEMENT?: string;
  /** A plan key. Default `free` with a provider, `self_hosted` with `none`. */
  BILLING_DEFAULT_PLAN?: string;
  /** Stripe provider only: a restricted key. A secret: never in the repo or a Wrangler file. */
  STRIPE_SECRET_KEY?: string;
  /** Stripe provider only: `whsec_...`. A secret. */
  STRIPE_WEBHOOK_SECRET?: string;
  /** `on` or `off`. Default `off`. Sets `managed_payments[enabled]` on Checkout Sessions (decision D2). */
  STRIPE_MANAGED_PAYMENTS?: string;
  /** The base of Checkout and Portal return URLs. Default: the dashboard URL. */
  BILLING_RETURN_BASE_URL?: string;
}

export const BILLING_PROVIDER_NAMES = ["stripe", "none", "memory"] as const;
export const BILLING_ENFORCEMENT_MODES = ["off", "shadow", "on"] as const;
export type BillingEnforcement = (typeof BILLING_ENFORCEMENT_MODES)[number];

export interface StripeConfig {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly managedPayments: boolean;
}

export interface BillingConfig {
  readonly provider: (typeof BILLING_PROVIDER_NAMES)[number];
  readonly enforcement: BillingEnforcement;
  readonly defaultPlan: PlanKey;
  /** An origin with no trailing slash. Return URLs go only here (no open redirect). */
  readonly returnBaseUrl: string;
  readonly stripe: StripeConfig | null;
}

/** Thrown at startup for a missing or wrong billing setting, never during a request. */
export class BillingConfigurationError extends Error {
  override readonly name = "BillingConfigurationError";
}

const trimmed = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === "" ? undefined : value.trim()));

function oneOf<const T extends readonly [string, ...string[]]>(name: string, values: T, value: string | undefined, fallback: T[number]): T[number] {
  if (value === undefined) return fallback;
  const parsed = z.enum(values).safeParse(value);
  if (!parsed.success) throw new BillingConfigurationError(`${name} "${value}" is not known. Use one of: ${values.join(", ")}.`);
  return parsed.data;
}

function requireSetting(value: string | undefined, name: string): string {
  if (value === undefined) throw new BillingConfigurationError(`Billing is not configured: set ${name}.`);
  return value;
}

/**
 * True under a test runner (`NODE_ENV=test`, which Vitest sets). The memory
 * provider's webhook secret is public, so a server must never run it.
 */
export function isTestRuntime(): boolean {
  const processLike = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return processLike?.env?.NODE_ENV === "test";
}

export function readBillingConfig(
  env: BillingEnv,
  options: {
    dashboardUrl?: string;
    /** Allows `BILLING_PROVIDER=memory`. Default: only under a test runner (`NODE_ENV=test`). */
    allowMemoryProvider?: boolean;
  } = {},
): BillingConfig {
  const read = (value: string | undefined) => trimmed.parse(value);
  const provider = oneOf("BILLING_PROVIDER", BILLING_PROVIDER_NAMES, read(env.BILLING_PROVIDER), "none");
  if (provider === "memory" && !(options.allowMemoryProvider ?? isTestRuntime())) {
    // The memory provider signs webhooks with a public secret and fakes payments.
    throw new BillingConfigurationError("BILLING_PROVIDER=memory is for tests only (NODE_ENV=test). Use stripe or none.");
  }
  const enforcement = oneOf("BILLING_ENFORCEMENT", BILLING_ENFORCEMENT_MODES, read(env.BILLING_ENFORCEMENT), "off");
  const defaultPlan = oneOf("BILLING_DEFAULT_PLAN", PLAN_KEYS, read(env.BILLING_DEFAULT_PLAN), provider === "none" ? "self_hosted" : "free");

  const baseText = read(env.BILLING_RETURN_BASE_URL) ?? read(options.dashboardUrl);
  const returnBaseUrl = requireSetting(baseText, "BILLING_RETURN_BASE_URL (or pass the dashboard URL)");
  let origin: string;
  try {
    const url = new URL(returnBaseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocol");
    if (url.pathname !== "/" || url.search || url.hash) throw new Error("path");
    origin = url.origin;
  } catch {
    throw new BillingConfigurationError(`BILLING_RETURN_BASE_URL "${returnBaseUrl}" must be an http(s) origin such as https://doxa.so.`);
  }

  let stripe: StripeConfig | null = null;
  if (provider === "stripe") {
    const secretKey = requireSetting(read(env.STRIPE_SECRET_KEY), "STRIPE_SECRET_KEY");
    const webhookSecret = requireSetting(read(env.STRIPE_WEBHOOK_SECRET), "STRIPE_WEBHOOK_SECRET");
    if (!/^(sk|rk)_(test|live)_/.test(secretKey)) throw new BillingConfigurationError("STRIPE_SECRET_KEY must be a Stripe secret or restricted key.");
    if (!webhookSecret.startsWith("whsec_")) throw new BillingConfigurationError("STRIPE_WEBHOOK_SECRET must start with whsec_.");
    const managed = oneOf("STRIPE_MANAGED_PAYMENTS", ["on", "off"] as const, read(env.STRIPE_MANAGED_PAYMENTS), "off");
    stripe = { secretKey, webhookSecret, managedPayments: managed === "on" };
  }

  return { provider, enforcement, defaultPlan, returnBaseUrl: origin, stripe };
}
