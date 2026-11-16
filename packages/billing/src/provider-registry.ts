import type { Catalog } from "./catalog/define";
import type { Clock } from "./clock";
import { BillingConfigurationError, type BillingConfig } from "./config";
import type { BillingProvider } from "./provider/provider";
import { MemoryBillingProvider } from "./providers/memory/memory-provider";
import { NoneBillingProvider } from "./providers/none/none-provider";
import { StripeBillingProvider } from "./providers/stripe/stripe-provider";

export interface BillingProviderDeps {
  readonly catalog: Catalog;
  readonly clock: Clock;
}

interface BillingProviderDefinition {
  /** Builds the provider from its own settings. Throws `BillingConfigurationError`. */
  create(config: BillingConfig, deps: BillingProviderDeps): BillingProvider;
}

/**
 * Every provider that Doxa can bill through. To add one, write
 * `providers/<name>/`, add its settings to `BillingEnv`, and add one entry
 * here. To switch providers, change `BILLING_PROVIDER`. Feature code does not
 * change.
 *
 * The registry imports the Stripe SDK, so it stays behind
 * `@doxahq/billing/payments` (the API Node origin only).
 */
export const BILLING_PROVIDERS = {
  none: { create: () => new NoneBillingProvider() },
  memory: { create: (_config, deps) => new MemoryBillingProvider({ clock: deps.clock, catalog: deps.catalog }) },
  stripe: {
    create: (config, deps) => {
      if (!config.stripe) throw new BillingConfigurationError("BILLING_PROVIDER=stripe needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.");
      return new StripeBillingProvider({ ...config.stripe, catalog: deps.catalog, clock: deps.clock });
    },
  },
} as const satisfies Record<string, BillingProviderDefinition>;

export type RegisteredBillingProviderName = keyof typeof BILLING_PROVIDERS;

export function isRegisteredBillingProvider(value: string): value is RegisteredBillingProviderName {
  return Object.hasOwn(BILLING_PROVIDERS, value);
}

/** Builds the provider that `BILLING_PROVIDER` names. */
export function createBillingProvider(config: BillingConfig, deps: BillingProviderDeps): BillingProvider {
  if (!isRegisteredBillingProvider(config.provider)) {
    const known = Object.keys(BILLING_PROVIDERS).join(", ");
    throw new BillingConfigurationError(`BILLING_PROVIDER "${config.provider}" has no provider in this build. Built: ${known}.`);
  }
  const definition: BillingProviderDefinition = BILLING_PROVIDERS[config.provider];
  return definition.create(config, deps);
}
