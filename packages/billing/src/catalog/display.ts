import type { Catalog, PriceDefinition } from "./define";
import type { BillingInterval } from "./keys";

/** `$1,548.00`, or `$129` with `{ cents: false }` for a whole amount. */
export function formatUsd(cents: number, options: { cents?: boolean } = {}): string {
  const whole = Number.isInteger(cents / 100);
  const showCents = options.cents ?? !whole;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: showCents ? 2 : 0,
  }).format(cents / 100);
}

/** The amount for one month: a yearly price divided by 12, rounded to the cent. */
export function monthlyEquivalentCents(price: Pick<PriceDefinition, "amountCents" | "interval">): number {
  return price.interval === "year" ? Math.round(price.amountCents / 12) : price.amountCents;
}

/** What a yearly price saves against 12 monthly payments, as a whole percent. `−19%` on the pricing page. */
export function yearlySavingsPercent(monthly: PriceDefinition, yearly: PriceDefinition): number {
  const twelveMonths = monthly.amountCents * 12;
  if (twelveMonths <= 0) return 0;
  return Math.round(((twelveMonths - yearly.amountCents) / twelveMonths) * 100);
}

export interface OfferPriceView {
  readonly priceKey: string;
  readonly interval: BillingInterval;
  readonly amountCents: number;
  readonly monthlyEquivalentCents: number;
}

export interface OfferView {
  readonly offerKey: string;
  readonly label: string;
  readonly open: boolean;
  readonly slotsLeft: number;
  readonly maxAccounts: number;
  /** The prices that a new Checkout uses now: the offer prices while open, else `then`. */
  readonly prices: Readonly<Record<BillingInterval, OfferPriceView>>;
  readonly yearlySavingsPercent: number;
}

/**
 * The public view of one offer for `GET /billing/offers` and the pricing page.
 * `takenSlots` counts `held` plus `claimed` slots (spec section 7.5).
 */
export function describeOffer(catalog: Catalog, offerKey: string, takenSlots: number): OfferView {
  const offer = catalog.offers[offerKey];
  if (!offer) throw new Error(`Unknown offer ${offerKey}`);
  const slotsLeft = Math.max(0, offer.maxAccounts - takenSlots);
  const open = slotsLeft > 0;
  const keys = open ? offer.prices : offer.then;
  const view = (interval: BillingInterval): OfferPriceView => {
    const priceKey = keys[interval];
    const price = catalog.prices[priceKey];
    if (!price) throw new Error(`Offer ${offerKey} names unknown price ${priceKey}`);
    return { priceKey, interval, amountCents: price.amountCents, monthlyEquivalentCents: monthlyEquivalentCents(price) };
  };
  const month = view("month");
  const year = view("year");
  const monthPrice = catalog.prices[month.priceKey];
  const yearPrice = catalog.prices[year.priceKey];
  return {
    offerKey,
    label: offer.label,
    open,
    slotsLeft,
    maxAccounts: offer.maxAccounts,
    prices: { month, year },
    yearlySavingsPercent: monthPrice && yearPrice ? yearlySavingsPercent(monthPrice, yearPrice) : 0,
  };
}

/** The offer whose `prices` list this price key, if any. */
export function findOfferOfPrice(catalog: Catalog, priceKey: string): string | null {
  for (const [offerKey, offer] of Object.entries(catalog.offers)) {
    if (Object.values(offer.prices).includes(priceKey)) return offerKey;
  }
  return null;
}
