import Stripe from "stripe";

import type { Catalog } from "../../../catalog/define";
import { formatUsd } from "../../../catalog/display";
import { BILLING_INTERVALS, PLAN_KEYS, type BillingInterval } from "../../../catalog/keys";
import { IMMUTABLE_PRICE_MESSAGE } from "../../../catalog/lock";
import { ProviderRejectedError } from "../../../provider/errors";
import type { CatalogSyncAction, CatalogSyncPlan, PortalConfiguration } from "../../../provider/provider";
import { callStripe, type StripeClient } from "../client";
import {
  META_CONFIG_HASH,
  META_MANAGED,
  META_OFFER,
  META_PLAN,
  META_PORTAL,
  META_PRICE_KEY,
  METER_CUSTOMER_KEY,
  METER_VALUE_KEY,
  PLAN_TAX_CODE,
  PORTAL_CONFIGURATIONS,
  STRIPE_PROVIDER,
  USAGE_PRODUCT_ID,
  USAGE_TAX_CODE,
  planProductId,
} from "../constants";
import { idOf } from "../mapping";

/**
 * Catalog sync (spec 7.3): reads the catalog and the Stripe account, then
 * plans and applies the difference.
 *
 * - Products have Doxa's own custom IDs, prices use the catalog key as
 *   `lookup_key`, the meter is found by `event_name` and the Portal
 *   configurations by `metadata.doxa_portal`. The repo stores no Stripe ID.
 * - Prices are immutable: a Stripe price whose amount or interval differs from
 *   the catalog stops the plan with "Prices are immutable. Add a new price
 *   version." The sync never updates an amount, never deletes a price, and
 *   archives a Doxa price only when it has no catalog entry and no live
 *   subscription.
 * - Every create call has an idempotency key. The plan is empty after an apply.
 */

/** A plan line, with the `keep` lines that the printed plan shows but that are not changes. */
export interface DetailedCatalogSyncPlan extends CatalogSyncPlan {
  /** `keep_price` lines: display only. */
  readonly keeps: readonly CatalogSyncAction[];
}

interface DesiredProduct {
  readonly id: string;
  readonly name: string;
  readonly taxCode: string;
  readonly metadata: Record<string, string>;
}

interface DesiredPrice {
  readonly key: string;
  readonly productId: string;
  readonly interval: BillingInterval;
  readonly unitAmountCents: number;
  readonly metered: boolean;
  readonly meter: string | null;
  readonly nickname: string;
  readonly metadata: Record<string, string>;
}

interface DesiredPortal {
  readonly name: PortalConfiguration;
  /** Product ID to price keys. */
  readonly products: readonly { readonly product: string; readonly priceKeys: readonly string[] }[];
  readonly hash: string;
}

interface Desired {
  readonly products: readonly DesiredProduct[];
  readonly meters: readonly string[];
  readonly prices: readonly DesiredPrice[];
  readonly portals: readonly DesiredPortal[];
}

interface AccountState {
  readonly products: ReadonlyMap<string, Stripe.Product>;
  readonly meters: ReadonlyMap<string, Stripe.Billing.Meter>;
  /** Prices by lookup key (the catalog keys and every Doxa price on Doxa products). */
  readonly prices: ReadonlyMap<string, Stripe.Price>;
  readonly portals: ReadonlyMap<PortalConfiguration, Stripe.BillingPortal.Configuration>;
}

/** A deterministic FNV-1a hash, so the sync needs no crypto API. */
function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const intervalLabel = (interval: BillingInterval) => (interval === "month" ? "month" : "year");

// Desired state ------------------------------------------------------------------------

function offerOfPrice(catalog: Catalog, priceKey: string): string | null {
  for (const [offerKey, offer] of Object.entries(catalog.offers)) {
    if (BILLING_INTERVALS.some((interval) => offer.prices[interval] === priceKey)) return offerKey;
  }
  return null;
}

function portalProducts(catalog: Catalog, name: PortalConfiguration): DesiredPortal["products"] {
  const byProduct = new Map<string, Map<BillingInterval, string>>();
  for (const [offerKey, offer] of Object.entries(catalog.offers)) {
    const side = name === "founder" ? offer.prices : offer.then;
    for (const interval of BILLING_INTERVALS) {
      const priceKey = side[interval];
      const price = catalog.prices[priceKey];
      if (!price) continue;
      const product = planProductId(price.plan);
      const intervals = byProduct.get(product) ?? new Map<BillingInterval, string>();
      const existing = intervals.get(interval);
      if (existing && existing !== priceKey) {
        // The Portal refuses two prices of one product with the same interval.
        throw new ProviderRejectedError(`Portal ${name}: offers ${offerKey} and another offer both name a ${interval} price of ${product}.`);
      }
      intervals.set(interval, priceKey);
      byProduct.set(product, intervals);
    }
  }
  return [...byProduct].map(([product, intervals]) => ({ product, priceKeys: BILLING_INTERVALS.flatMap((interval) => intervals.get(interval) ?? []) }));
}

export function desiredState(catalog: Catalog): Desired {
  const products: DesiredProduct[] = [];
  for (const plan of PLAN_KEYS) {
    if (!Object.values(catalog.prices).some((price) => price.plan === plan)) continue;
    products.push({
      id: planProductId(plan),
      name: `Doxa ${catalog.plans[plan].name}`,
      taxCode: PLAN_TAX_CODE,
      metadata: { [META_MANAGED]: "true", [META_PLAN]: plan },
    });
  }
  if (Object.keys(catalog.usagePrices).length > 0) {
    products.push({ id: USAGE_PRODUCT_ID, name: "Doxa AI usage", taxCode: USAGE_TAX_CODE, metadata: { [META_MANAGED]: "true" } });
  }

  const meters = [...new Set(Object.values(catalog.usagePrices).map((usage) => usage.meter))];

  const prices: DesiredPrice[] = [];
  for (const [key, price] of Object.entries(catalog.prices)) {
    const offer = offerOfPrice(catalog, key);
    prices.push({
      key,
      productId: planProductId(price.plan),
      interval: price.interval,
      unitAmountCents: price.amountCents,
      metered: false,
      meter: null,
      nickname: `${catalog.plans[price.plan].name} ${price.interval === "month" ? "monthly" : "yearly"}${offer ? ` (${offer})` : ""} ${key}`,
      metadata: { [META_MANAGED]: "true", [META_PRICE_KEY]: key, [META_PLAN]: price.plan, ...(offer ? { [META_OFFER]: offer } : {}) },
    });
  }
  for (const [key, usage] of Object.entries(catalog.usagePrices)) {
    prices.push({
      key,
      productId: USAGE_PRODUCT_ID,
      interval: usage.interval,
      unitAmountCents: usage.unitAmountCents,
      metered: true,
      meter: usage.meter,
      nickname: `AI usage ${usage.interval === "month" ? "monthly" : "yearly"} ${key}`,
      metadata: { [META_MANAGED]: "true", [META_PRICE_KEY]: key },
    });
  }

  const portals: DesiredPortal[] = PORTAL_CONFIGURATIONS.map((name) => {
    const products = portalProducts(catalog, name);
    return { name, products, hash: hashText(JSON.stringify({ v: 1, features: portalFeatureSummary, products })) };
  });

  return { products, meters, prices, portals };
}

/** The Portal features both configurations share. Part of the configuration hash. */
const portalFeatureSummary = {
  invoice_history: true,
  payment_method_update: true,
  customer_update: ["email", "name", "address"],
  subscription_cancel: "at_period_end",
  subscription_update: "off",
} as const;

// Reading the account -------------------------------------------------------------------

function isMissing(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeInvalidRequestError && error.code === "resource_missing";
}

async function retrieveProduct(stripe: StripeClient, id: string): Promise<Stripe.Product | null> {
  try {
    return await stripe.products.retrieve(id);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function readAccount(stripe: StripeClient, desired: Desired): Promise<AccountState> {
  return callStripe("catalog sync read", async () => {
    const products = new Map<string, Stripe.Product>();
    for (const product of desired.products) {
      const found = await retrieveProduct(stripe, product.id);
      if (found) products.set(product.id, found);
    }

    const meters = new Map<string, Stripe.Billing.Meter>();
    for await (const meter of stripe.billing.meters.list({ limit: 100 })) {
      if (desired.meters.includes(meter.event_name)) meters.set(meter.event_name, meter);
    }

    const prices = new Map<string, Stripe.Price>();
    const keys = desired.prices.map((price) => price.key);
    for (let start = 0; start < keys.length; start += 10) {
      const page = await stripe.prices.list({ lookup_keys: keys.slice(start, start + 10), limit: 100 });
      for (const price of page.data) if (price.lookup_key) prices.set(price.lookup_key, price);
    }
    for (const product of products.values()) {
      for await (const price of stripe.prices.list({ product: product.id, limit: 100 })) {
        if (price.lookup_key && price.metadata?.[META_MANAGED] === "true" && !prices.has(price.lookup_key)) prices.set(price.lookup_key, price);
      }
    }

    const portals = new Map<PortalConfiguration, Stripe.BillingPortal.Configuration>();
    for await (const configuration of stripe.billingPortal.configurations.list({ limit: 100 })) {
      const name = configuration.metadata?.[META_PORTAL];
      if ((PORTAL_CONFIGURATIONS as readonly string[]).includes(name ?? "") && configuration.metadata?.[META_MANAGED] === "true") {
        const typed = name as PortalConfiguration;
        // Prefer an active configuration when several carry the tag.
        if (!portals.has(typed) || configuration.active) portals.set(typed, configuration);
      }
    }
    return { products, meters, prices, portals };
  });
}

async function hasLiveSubscription(stripe: StripeClient, priceId: string): Promise<boolean> {
  return callStripe("catalog sync read subscriptions", async () => {
    for await (const subscription of stripe.subscriptions.list({ price: priceId, status: "all", limit: 100 })) {
      if (subscription.status !== "canceled" && subscription.status !== "incomplete_expired") return true;
    }
    return false;
  });
}

// Planning -----------------------------------------------------------------------------

function priceLine(price: DesiredPrice): string {
  return price.metered
    ? `${formatUsd(price.unitAmountCents, { cents: true })} per credit / ${intervalLabel(price.interval)} (meter ${price.meter})`
    : `${formatUsd(price.unitAmountCents, { cents: true })} / ${intervalLabel(price.interval)}`;
}

function priceMismatch(want: DesiredPrice, have: Stripe.Price, meterId: string | null): string | null {
  const problems: string[] = [];
  if (idOf(have.product) !== want.productId) problems.push(`product ${idOf(have.product)} (catalog: ${want.productId})`);
  if (have.currency !== "usd") problems.push(`currency ${have.currency}`);
  if (have.unit_amount !== want.unitAmountCents) problems.push(`amount ${have.unit_amount} (catalog: ${want.unitAmountCents})`);
  if (have.recurring?.interval !== want.interval || (have.recurring?.interval_count ?? 1) !== 1) {
    problems.push(`interval ${have.recurring?.interval_count ?? "?"} ${have.recurring?.interval ?? "none"} (catalog: ${want.interval})`);
  }
  const usageType = want.metered ? "metered" : "licensed";
  if (have.recurring?.usage_type !== usageType) problems.push(`usage type ${have.recurring?.usage_type ?? "none"} (catalog: ${usageType})`);
  if (want.metered && meterId !== null && have.recurring?.meter !== meterId) problems.push("another meter");
  return problems.length > 0 ? `Stripe price ${want.key} differs from the catalog: ${problems.join(", ")}. ${IMMUTABLE_PRICE_MESSAGE}` : null;
}

function productNeedsUpdate(want: DesiredProduct, have: Stripe.Product): boolean {
  return idOf(have.tax_code) !== want.taxCode || !have.active || have.name !== want.name || have.metadata?.[META_MANAGED] !== "true";
}

function meterProblem(meter: Stripe.Billing.Meter): string | null {
  const ok =
    meter.default_aggregation.formula === "sum" &&
    meter.customer_mapping.event_payload_key === METER_CUSTOMER_KEY &&
    meter.value_settings.event_payload_key === METER_VALUE_KEY;
  return ok ? null : `Stripe meter ${meter.event_name} does not sum "${METER_VALUE_KEY}" by "${METER_CUSTOMER_KEY}". Fix or rename it in the Stripe dashboard.`;
}

/** Plans the sync. Throws `ProviderRejectedError` when Stripe holds a price that the catalog contradicts. */
export async function planStripeCatalogSync(stripe: StripeClient, catalog: Catalog): Promise<DetailedCatalogSyncPlan> {
  const desired = desiredState(catalog);
  const state = await readAccount(stripe, desired);
  return planFrom(stripe, desired, state);
}

async function planFrom(stripe: StripeClient, desired: Desired, state: AccountState): Promise<DetailedCatalogSyncPlan> {
  const actions: CatalogSyncAction[] = [];
  const keeps: CatalogSyncAction[] = [];
  const problems: string[] = [];

  for (const product of desired.products) {
    const have = state.products.get(product.id);
    if (!have) actions.push({ kind: "create_product", key: product.id, description: `create product  ${product.id}  "${product.name}" (tax code ${product.taxCode})` });
    else if (productNeedsUpdate(product, have)) {
      actions.push({ kind: "set_tax_code", key: product.id, description: `update product  ${product.id}  "${product.name}" (tax code ${product.taxCode}, active)` });
    }
  }

  for (const eventName of desired.meters) {
    const have = state.meters.get(eventName);
    if (!have) actions.push({ kind: "create_meter", key: eventName, description: `create meter    ${eventName}  (sum of ${METER_VALUE_KEY} by ${METER_CUSTOMER_KEY})` });
    else {
      const problem = meterProblem(have);
      if (problem) problems.push(problem);
      if (have.status !== "active") actions.push({ kind: "create_meter", key: eventName, description: `reactivate meter ${eventName}` });
    }
  }

  for (const price of desired.prices) {
    const have = state.prices.get(price.key);
    if (!have) {
      actions.push({ kind: "create_price", key: price.key, description: `create price    ${price.key}  ${priceLine(price)}` });
      continue;
    }
    const meterId = price.meter ? (state.meters.get(price.meter)?.id ?? null) : null;
    const mismatch = priceMismatch(price, have, meterId);
    if (mismatch) problems.push(mismatch);
    else if (!have.active) actions.push({ kind: "create_price", key: price.key, description: `reactivate price ${price.key}  ${priceLine(price)}` });
    else keeps.push({ kind: "keep_price", key: price.key, description: `keep   price    ${price.key}  ${priceLine(price)}` });
  }

  const catalogKeys = new Set(desired.prices.map((price) => price.key));
  for (const [key, have] of state.prices) {
    if (catalogKeys.has(key) || !have.active || have.metadata?.[META_MANAGED] !== "true") continue;
    if (await hasLiveSubscription(stripe, have.id)) {
      keeps.push({ kind: "keep_price", key, description: `keep   price    ${key}  (no catalog entry, has live subscriptions)` });
    } else {
      actions.push({ kind: "archive_price", key, description: `archive price   ${key}  (no catalog entry, 0 live subscriptions)` });
    }
  }

  for (const portal of desired.portals) {
    const have = state.portals.get(portal.name);
    if (!have || !have.active || have.metadata?.[META_CONFIG_HASH] !== portal.hash) {
      const prices = portal.products.flatMap((product) => product.priceKeys).join(", ");
      actions.push({ kind: "update_portal", key: portal.name, description: `${have ? "update" : "create"} portal   ${portal.name}  (switch between ${prices || "no prices"})` });
    }
  }

  if (problems.length > 0) throw new ProviderRejectedError(problems.join("\n"), "catalog_conflict");
  return { provider: STRIPE_PROVIDER, actions, keeps };
}

// Applying -----------------------------------------------------------------------------

const actionId = (action: Pick<CatalogSyncAction, "kind" | "key">) => `${action.kind}:${action.key}`;

/**
 * Applies a plan. It plans again from the live account and runs only the
 * actions that are in both, so a stale or repeated plan is safe. Order:
 * products, meters, prices, Portal configurations, archives.
 */
export async function applyStripeCatalogSync(stripe: StripeClient, catalog: Catalog, plan: CatalogSyncPlan): Promise<{ applied: number }> {
  const wanted = new Set(plan.actions.map(actionId));
  const desired = desiredState(catalog);
  const state = await readAccount(stripe, desired);
  const fresh = await planFrom(stripe, desired, state);
  const todo = fresh.actions.filter((action) => wanted.has(actionId(action)));
  const has = (kind: CatalogSyncAction["kind"], key: string) => todo.some((action) => action.kind === kind && action.key === key);
  let applied = 0;

  for (const product of desired.products) {
    if (has("create_product", product.id)) {
      await callStripe("create product", () =>
        stripe.products.create(
          { id: product.id, name: product.name, tax_code: product.taxCode, metadata: product.metadata },
          { idempotencyKey: `doxa-catalog-sync:product:${product.id}` },
        ),
      );
      applied += 1;
    } else if (has("set_tax_code", product.id)) {
      await callStripe("update product", () =>
        stripe.products.update(product.id, { name: product.name, tax_code: product.taxCode, active: true, metadata: product.metadata }),
      );
      applied += 1;
    }
  }

  const meterIds = new Map<string, string>();
  for (const [eventName, meter] of state.meters) meterIds.set(eventName, meter.id);
  for (const eventName of desired.meters) {
    if (!has("create_meter", eventName)) continue;
    const existing = state.meters.get(eventName);
    if (existing) {
      await callStripe("reactivate meter", () => stripe.billing.meters.reactivate(existing.id));
    } else {
      const created = await callStripe("create meter", () =>
        stripe.billing.meters.create(
          {
            display_name: "Doxa AI overage",
            event_name: eventName,
            default_aggregation: { formula: "sum" },
            customer_mapping: { type: "by_id", event_payload_key: METER_CUSTOMER_KEY },
            value_settings: { event_payload_key: METER_VALUE_KEY },
          },
          { idempotencyKey: `doxa-catalog-sync:meter:${eventName}` },
        ),
      );
      meterIds.set(eventName, created.id);
    }
    applied += 1;
  }

  const priceIds = new Map<string, string>();
  for (const [key, price] of state.prices) priceIds.set(key, price.id);
  for (const price of desired.prices) {
    if (!has("create_price", price.key)) continue;
    const existing = state.prices.get(price.key);
    if (existing) {
      await callStripe("reactivate price", () => stripe.prices.update(existing.id, { active: true }));
    } else {
      const meterId = price.meter ? meterIds.get(price.meter) : undefined;
      if (price.metered && !meterId) throw new ProviderRejectedError(`Usage price ${price.key} needs meter ${price.meter}, which does not exist.`);
      const created = await callStripe("create price", () =>
        stripe.prices.create(
          {
            product: price.productId,
            currency: "usd",
            unit_amount: price.unitAmountCents,
            // Tax goes on top of the price (US style). Managed Payments uses
            // the price's tax behavior. Set it explicitly, not by account default.
            tax_behavior: "exclusive",
            lookup_key: price.key,
            nickname: price.nickname,
            metadata: price.metadata,
            recurring: price.metered
              ? { interval: price.interval, interval_count: 1, usage_type: "metered", ...(meterId ? { meter: meterId } : {}) }
              : { interval: price.interval, interval_count: 1, usage_type: "licensed" },
          },
          { idempotencyKey: `doxa-catalog-sync:price:${price.key}:${price.unitAmountCents}:${price.interval}` },
        ),
      );
      priceIds.set(price.key, created.id);
    }
    applied += 1;
  }

  for (const portal of desired.portals) {
    if (!has("update_portal", portal.name)) continue;
    const products = portal.products.map((product) => ({
      product: product.product,
      prices: product.priceKeys.map((key) => {
        const id = priceIds.get(key);
        if (!id) throw new ProviderRejectedError(`Portal ${portal.name} needs price ${key}, which does not exist.`);
        return id;
      }),
    }));
    const params = {
      business_profile: { headline: "Manage your Doxa subscription" },
      features: {
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        customer_update: { enabled: true, allowed_updates: [...portalFeatureSummary.customer_update] },
        subscription_cancel: { enabled: true, mode: "at_period_end" as const, proration_behavior: "none" as const },
        // spec 13: the Portal cannot update a subscription with a usage price.
        // The dashboard switches monthly/yearly through the API (switchPlanPrice).
        subscription_update: { enabled: false },
      },
      metadata: { [META_MANAGED]: "true", [META_PORTAL]: portal.name, [META_CONFIG_HASH]: portal.hash },
    };
    const existing = state.portals.get(portal.name);
    if (existing) {
      await callStripe("update portal configuration", () => stripe.billingPortal.configurations.update(existing.id, { ...params, active: true }));
    } else {
      await callStripe("create portal configuration", () =>
        stripe.billingPortal.configurations.create(params, { idempotencyKey: `doxa-catalog-sync:portal:${portal.name}:${portal.hash}` }),
      );
    }
    applied += 1;
  }

  for (const action of todo) {
    if (action.kind !== "archive_price") continue;
    const price = state.prices.get(action.key);
    if (!price) continue;
    await callStripe("archive price", () => stripe.prices.update(price.id, { active: false }));
    applied += 1;
  }

  return { applied };
}

/** The plan as printed lines, changes first. */
export function formatCatalogSyncPlan(plan: DetailedCatalogSyncPlan): string[] {
  const lines = [...plan.actions, ...plan.keeps].map((action) => action.description);
  return lines.length > 0 ? lines : ["nothing to sync"];
}
