/**
 * `@doxahq/billing/testing`: the memory store, the memory provider, a fake
 * clock, fixtures, a wired test harness, the ledger invariant check and the
 * provider contract suite. Tests only.
 */
import { describe, expect, it } from "vitest";

import { createAccountResolver, type ProjectOwnershipPort } from "./accounts/resolve-account";
import { BillingAccountSettings } from "./accounts/settings";
import type { Catalog } from "./catalog/define";
import { DOXA_CATALOG } from "./catalog/doxa";
import { BILLING_INTERVALS, type PlanKey } from "./catalog/keys";
import type { Clock } from "./clock";
import { CreditLedger } from "./credits/ledger";
import { formatUsd12 } from "./credits/usd";
import { CreditMeter, type MeterEvents } from "./credits/meter";
import { BillingEntitlements } from "./entitlements/service";
import { OfferSlots } from "./offers/founder";
import type { BillingLifecycleEvents } from "./lifecycle-events";
import { BillingPayments } from "./payments/service";
import { BillingWebhooks } from "./payments/webhooks";
import { ProviderSignatureError } from "./provider/errors";
import type { BillingProvider, ProviderCustomerRef, RawWebhook } from "./provider/provider";
import { MemoryBillingProvider } from "./providers/memory/memory-provider";
import { UsageQuota } from "./quotas/daily-quota";
import { MemoryBillingStore } from "./store/memory";
import type { BillingStore } from "./store/store";
import type { Reservation, SubscriptionRecord } from "./store/types";

export { MemoryBillingStore } from "./store/memory";
export { MEMORY_PROVIDER, MEMORY_SIGNATURE_HEADER, MEMORY_TEST_CARD, MemoryBillingProvider, type NewProviderEvent } from "./providers/memory/memory-provider";

/** 2026-11-13T12:00:00Z, the default start of every test. */
export const TEST_NOW = new Date("2026-11-13T12:00:00.000Z");

/** A clock that moves only when a test moves it. */
export class FakeClock implements Clock {
  private current: Date;

  constructor(start: Date = TEST_NOW) {
    this.current = new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(at: Date): void {
    this.current = new Date(at.getTime());
  }

  advance(ms: number): Date {
    this.current = new Date(this.current.getTime() + ms);
    return this.now();
  }
}

/** A subscription mirror row with test defaults. */
export function subscriptionFixture(overrides: Partial<SubscriptionRecord> & Pick<SubscriptionRecord, "accountId">): SubscriptionRecord {
  const start = overrides.currentPeriodStart ?? TEST_NOW;
  return {
    provider: "memory",
    providerSubscriptionId: "sub_test",
    priceKey: "pro_monthly_founder_v2",
    planKey: "pro",
    status: "active",
    billingAnchor: start,
    currentPeriodStart: start,
    currentPeriodEnd: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate())),
    cancelAtPeriodEnd: false,
    trialEnd: null,
    pastDueSince: null,
    syncedAt: start,
    ...overrides,
  };
}

/** Projects for the account resolver: `projectId -> owner`. */
export class MemoryProjects implements ProjectOwnershipPort {
  readonly projects = new Map<string, { userId: string; teamId: string | null }>();

  set(projectId: string, owner: { userId: string; teamId?: string | null }): void {
    this.projects.set(projectId, { userId: owner.userId, teamId: owner.teamId ?? null });
  }

  async getProjectOwnership(projectId: string) {
    return this.projects.get(projectId) ?? null;
  }
}

type LifecycleMethod = keyof BillingLifecycleEvents;

/** One call of a `BillingLifecycleEvents` method, as a test reads it. */
export type RecordedLifecycleEvent = {
  [Method in LifecycleMethod]: { readonly method: Method; readonly event: Parameters<NonNullable<BillingLifecycleEvents[Method]>>[0] };
}[LifecycleMethod];

/** A lifecycle listener that pushes each call into `into`, in order. */
export function recordingLifecycleEvents(into: RecordedLifecycleEvent[]): Required<BillingLifecycleEvents> {
  return {
    checkoutStarted: (event) => into.push({ method: "checkoutStarted", event }),
    checkoutCompleted: (event) => into.push({ method: "checkoutCompleted", event }),
    checkoutExpired: (event) => into.push({ method: "checkoutExpired", event }),
    subscriptionChanged: (event) => into.push({ method: "subscriptionChanged", event }),
    invoiceSettled: (event) => into.push({ method: "invoiceSettled", event }),
  };
}

export interface TestBilling {
  readonly clock: FakeClock;
  readonly catalog: Catalog;
  readonly store: MemoryBillingStore;
  readonly provider: MemoryBillingProvider;
  readonly projects: MemoryProjects;
  readonly accounts: ReturnType<typeof createAccountResolver>;
  readonly entitlements: BillingEntitlements;
  readonly ledger: CreditLedger;
  readonly meter: CreditMeter;
  readonly offers: OfferSlots;
  readonly quota: UsageQuota;
  readonly settings: BillingAccountSettings;
  readonly payments: BillingPayments;
  readonly webhooks: BillingWebhooks;
  readonly counters: { name: string; fields: Readonly<Record<string, string | number | boolean | null>> }[];
  /** Every `BillingLifecycleEvents` call of the payments service and the webhooks, in order. */
  readonly lifecycle: RecordedLifecycleEvent[];
  /** Writes a subscription mirror row directly, as `syncCustomer` would. */
  setSubscription(record: SubscriptionRecord): Promise<void>;
  /** Delivers every webhook in the memory provider's outbox. */
  deliverWebhooks(): Promise<number[]>;
}

/** Every billing service wired over the memory store and the memory provider. */
export function createTestBilling(options: { catalog?: Catalog; defaultPlan?: PlanKey; now?: Date; priceTableHash?: string } = {}): TestBilling {
  const clock = new FakeClock(options.now ?? TEST_NOW);
  const catalog = options.catalog ?? DOXA_CATALOG;
  const defaultPlan = options.defaultPlan ?? "free";
  const store = new MemoryBillingStore();
  const provider = new MemoryBillingProvider({ clock, catalog });
  const projects = new MemoryProjects();
  const counters: TestBilling["counters"] = [];
  const events: MeterEvents = { count: (name, fields) => counters.push({ name, fields }) };
  const recorded: RecordedLifecycleEvent[] = [];
  const lifecycle = recordingLifecycleEvents(recorded);
  const accounts = createAccountResolver({ store, catalog, clock, projects, defaultPlan });
  const entitlements = new BillingEntitlements({ store, catalog, clock, defaultPlan, accounts });
  const ledger = new CreditLedger({ store, catalog, clock });
  const meter = new CreditMeter({
    store,
    catalog,
    clock,
    ledger,
    creditContext: entitlements.creditContext,
    priceTableHash: options.priceTableHash ?? "test-price-table",
    events,
  });
  const offers = new OfferSlots({ store, catalog, clock });
  const quota = new UsageQuota({ store, clock });
  const settings = new BillingAccountSettings({ store, catalog, clock });
  const payments = new BillingPayments({
    store,
    catalog,
    clock,
    provider,
    ledger,
    offers,
    entitlements,
    defaultPlan,
    returnBaseUrl: "https://doxa.test",
    events,
    lifecycle,
  });
  const webhooks = new BillingWebhooks({ store, catalog, clock, provider, payments, ledger, offers, lifecycle });
  return {
    clock,
    catalog,
    store,
    provider,
    projects,
    accounts,
    entitlements,
    ledger,
    meter,
    offers,
    quota,
    settings,
    payments,
    webhooks,
    counters,
    lifecycle: recorded,
    setSubscription: (record) => store.withAccountLock(record.accountId, clock.now(), (tx) => tx.upsertSubscription(record)),
    async deliverWebhooks() {
      const statuses: number[] = [];
      for (let round = 0; round < 10; round += 1) {
        const batch = provider.drainWebhooks();
        if (batch.length === 0) break;
        for (const raw of batch) statuses.push((await webhooks.handle(raw)).status);
      }
      return statuses;
    },
  };
}

/**
 * Spec 10.2 rule 7: the sum of ledger entries equals the sum of grant
 * `remaining` minus the open debt. Works on any store through its reads.
 */
/**
 * A second held reservation of `from`'s subject, written straight to the
 * store: the state that two admissions of one job left before the ledger
 * refused a second hold (`RESERVATION_IN_USE`). Settle, release and the
 * sweep must still handle it.
 */
export async function insertLegacyHeldReservation(
  store: BillingStore,
  from: Reservation,
  input: { idempotencyKey: string; baseCredits: number; amount: number; at: Date },
): Promise<Reservation> {
  return store.withAccountLock(from.accountId, input.at, (tx) =>
    tx.insertReservation({
      actionKey: from.actionKey,
      subjectKind: from.subjectKind,
      subjectId: from.subjectId,
      baseCredits: input.baseCredits,
      amount: input.amount,
      capCredits: from.capCredits,
      markupHundredths: from.markupHundredths,
      unitPriceCents: from.unitPriceCents,
      inFlightMarginCredits: from.inFlightMarginCredits,
      consumedCostPico: 0n,
      stopReason: null,
      status: "held",
      idempotencyKey: input.idempotencyKey,
      expiresAt: from.expiresAt,
      settledAmount: null,
    }),
  );
}

export async function readLedgerInvariant(
  store: BillingStore,
  accountId: string,
  entries: readonly { kind: string; credits: number }[],
): Promise<{ ledgerSum: number; grantRemaining: number; openDebt: number; holds: boolean }> {
  const grants = await store.listGrants(accountId);
  const ledgerSum = entries.reduce((sum, entry) => sum + entry.credits, 0);
  const grantRemaining = grants.reduce((sum, grant) => sum + grant.remaining, 0);
  const debt = entries.filter((entry) => entry.kind === "debt").reduce((sum, entry) => sum - entry.credits, 0);
  const paid = entries.filter((entry) => entry.kind === "debt_paid").reduce((sum, entry) => sum + entry.credits, 0);
  const openDebt = debt - paid;
  return { ledgerSum, grantRemaining, openDebt, holds: ledgerSum === grantRemaining - openDebt };
}

/** The ledger invariant over the memory store. */
export async function checkLedgerInvariant(store: MemoryBillingStore, accountId: string) {
  return readLedgerInvariant(store, accountId, store.allLedgerEntries(accountId));
}

// Provider contract suite (spec 20.3) ---------------------------------------------

export interface ProviderContractHarness {
  readonly provider: BillingProvider;
  readonly catalog: Catalog;
  /** Pays an open Checkout as a customer would. */
  payCheckout(checkoutId: string): Promise<void>;
  /** Sets cancel at period end, as the Customer Portal would. */
  cancelAtPeriodEnd(customer: ProviderCustomerRef): Promise<void>;
  /** The next signed webhook the provider sent, or null. */
  nextWebhook(): Promise<RawWebhook | null>;
}

/** Runs one suite against any provider. Every provider must pass it. */
export function describeBillingProviderContract(name: string, factory: () => Promise<ProviderContractHarness> | ProviderContractHarness): void {
  describe(`billing provider contract: ${name}`, () => {
    const checkoutInput = (harness: ProviderContractHarness, customer: ProviderCustomerRef, priceKey: string, suffix: string) => {
      const price = harness.catalog.prices[priceKey];
      if (!price) throw new Error(`No price ${priceKey}`);
      return {
        accountId: `acct_contract_${suffix}`,
        customer,
        priceKey,
        usagePriceKey: price.usage,
        trialDays: null,
        expiresAt: new Date(Date.now() + 30 * 60_000),
        successUrl: "https://doxa.test/dashboard/billing/acct?checkout={CHECKOUT_ID}",
        cancelUrl: "https://doxa.test/dashboard/billing/acct",
        idempotencyKey: `checkout:contract:${priceKey}:${suffix}`,
      };
    };

    const newCustomer = (harness: ProviderContractHarness, suffix: string) =>
      harness.provider.ensureCustomer({
        accountId: `acct_contract_${suffix}`,
        email: null,
        name: null,
        existing: null,
        idempotencyKey: `customer:acct_contract_${suffix}`,
      });

    it("creates a customer idempotently", async () => {
      const harness = await factory();
      const first = await newCustomer(harness, "idem");
      const again = await newCustomer(harness, "idem");
      const reused = await harness.provider.ensureCustomer({
        accountId: "acct_contract_idem",
        email: null,
        name: null,
        existing: first,
        idempotencyKey: "customer:other-key",
      });
      expect(again.customerId).toBe(first.customerId);
      expect(reused.customerId).toBe(first.customerId);
      expect(first.provider).toBe(harness.provider.name);
    });

    it("creates a Checkout link for each offer price", async () => {
      const harness = await factory();
      const customer = await newCustomer(harness, "links");
      const keys = new Set<string>();
      for (const offer of Object.values(harness.catalog.offers)) {
        for (const interval of BILLING_INTERVALS) {
          keys.add(offer.prices[interval]);
          keys.add(offer.then[interval]);
        }
      }
      for (const priceKey of keys) {
        const link = await harness.provider.createCheckout(checkoutInput(harness, customer, priceKey, "links"));
        expect(link.url).toMatch(/^https:\/\//);
        expect(link.checkoutId).not.toBe("");
      }
    });

    it("gives a customer state with the paid price key, then cancel at period end", async () => {
      const harness = await factory();
      const customer = await newCustomer(harness, "paid");
      const priceKey = Object.keys(harness.catalog.prices)[0] ?? "";
      const link = await harness.provider.createCheckout(checkoutInput(harness, customer, priceKey, "paid"));
      await harness.payCheckout(link.checkoutId);
      const checkout = await harness.provider.fetchCheckout(link.checkoutId);
      expect(checkout.status).toBe("complete");
      const state = await harness.provider.fetchCustomerState(customer);
      expect(state.subscription?.priceKey).toBe(priceKey);
      expect(["active", "trialing"]).toContain(state.subscription?.status);
      await harness.cancelAtPeriodEnd(customer);
      expect((await harness.provider.fetchCustomerState(customer)).subscription?.cancelAtPeriodEnd).toBe(true);
    });

    it("round-trips a signed webhook and refuses a tampered one", async () => {
      const harness = await factory();
      const customer = await newCustomer(harness, "hook");
      const priceKey = Object.keys(harness.catalog.prices)[0] ?? "";
      const link = await harness.provider.createCheckout(checkoutInput(harness, customer, priceKey, "hook"));
      await harness.payCheckout(link.checkoutId);
      const raw = await harness.nextWebhook();
      expect(raw).not.toBeNull();
      if (!raw) return;
      const event = await harness.provider.parseWebhook(raw);
      expect(typeof event.id).toBe("string");
      expect(event.occurredAt).toBeInstanceOf(Date);
      await expect(harness.provider.parseWebhook({ ...raw, body: `${raw.body} ` })).rejects.toBeInstanceOf(ProviderSignatureError);
    });

    it("lists invoices", async () => {
      const harness = await factory();
      const customer = await newCustomer(harness, "invoices");
      const priceKey = Object.keys(harness.catalog.prices)[0] ?? "";
      const link = await harness.provider.createCheckout(checkoutInput(harness, customer, priceKey, "invoices"));
      await harness.payCheckout(link.checkoutId);
      const page = await harness.provider.listInvoices({ customer, limit: 10, cursor: null });
      expect(page.items.length).toBeGreaterThan(0);
      for (const invoice of page.items) expect(Number.isInteger(invoice.amountDueCents)).toBe(true);
    });

    it("reads the card and previews an interval switch without a change, when it supports them", async () => {
      const harness = await factory();
      const customer = await newCustomer(harness, "reads");
      const priceKey = "pro_monthly_founder_v2";
      const link = await harness.provider.createCheckout(checkoutInput(harness, customer, priceKey, "reads"));
      await harness.payCheckout(link.checkoutId);
      const before = await harness.provider.fetchCustomerState(customer);
      const subscriptionId = before.subscription?.subscriptionId ?? "";
      const card = await harness.provider.fetchPaymentMethod?.({ customer, subscriptionId });
      if (card) {
        expect(card.last4).toMatch(/^\d{4}$/);
        expect(card.expMonth).toBeGreaterThanOrEqual(1);
      }
      const preview = await harness.provider.previewPlanSwitch?.({ customer, subscriptionId, priceKey: "pro_yearly_founder_v2" });
      if (preview) {
        for (const cents of [preview.chargeTodayCents, preview.creditCents, preview.balanceAfterCents]) expect(Number.isSafeInteger(cents) && cents >= 0).toBe(true);
      }
      expect((await harness.provider.fetchCustomerState(customer)).subscription?.priceKey).toBe(priceKey);
    });

    it("has an empty catalog sync plan after an apply", async () => {
      const harness = await factory();
      const plan = await harness.provider.planCatalogSync(harness.catalog);
      await harness.provider.applyCatalogSync(plan);
      const again = await harness.provider.planCatalogSync(harness.catalog);
      expect(again.actions).toEqual([]);
    });
  });
}

/** The contract harness of the memory provider. */
export function memoryProviderHarness(options: { catalog?: Catalog } = {}): ProviderContractHarness {
  const catalog = options.catalog ?? DOXA_CATALOG;
  const clock = new FakeClock(new Date());
  const provider = new MemoryBillingProvider({ clock, catalog });
  return {
    provider,
    catalog,
    payCheckout: async (checkoutId) => {
      provider.completeCheckout(checkoutId);
    },
    cancelAtPeriodEnd: async (customer) => provider.setCancelAtPeriodEnd(customer, true),
    nextWebhook: async () => provider.drainWebhooks()[0] ?? null,
  };
}

// Store contract suite (spec 20.2) -------------------------------------------------

/**
 * The concurrency and atomicity checks of spec 20.2, against any
 * `BillingStore`. The memory store runs it always; the Postgres store runs it
 * opt-in (`BILLING_TEST_DATABASE_URL`). `makeStore` must return an empty store.
 */
export function describeBillingStoreContract(name: string, makeStore: () => Promise<BillingStore> | BillingStore): void {
  describe(`billing store contract: ${name}`, () => {
    const services = async () => {
      const store = await makeStore();
      const clock = new FakeClock();
      const catalog = DOXA_CATALOG;
      const projects = new MemoryProjects();
      const accounts = createAccountResolver({ store, catalog, clock, projects, defaultPlan: "free" });
      const entitlements = new BillingEntitlements({ store, catalog, clock, defaultPlan: "free", accounts });
      const ledger = new CreditLedger({ store, catalog, clock });
      const meter = new CreditMeter({ store, catalog, clock, ledger, creditContext: entitlements.creditContext, priceTableHash: "contract" });
      return { store, clock, catalog, accounts, entitlements, ledger, meter, offers: new OfferSlots({ store, catalog, clock }), quota: new UsageQuota({ store, clock }) };
    };
    const ctx = (payg: boolean) => ({
      enforceCredits: true,
      planAllowsPayg: payg,
      trialing: false,
      allowance: null,
      trialGrant: null,
      windowAnchor: TEST_NOW,
    });
    let seq = 0;
    const reserve = (accountId: string, amount: number, payg = false) => {
      seq += 1;
      return {
        accountId,
        actionKey: "generation.run" as const,
        subjectKind: "job",
        subjectId: `contract_${seq}`,
        amount,
        baseCredits: 50,
        capCredits: 5_000,
        markupHundredths: 300,
        unitPriceCents: 1,
        inFlightMarginCredits: 300,
        idempotencyKey: `job:contract_${seq}:reserve`,
        context: ctx(payg),
      };
    };
    const owner = (s: Awaited<ReturnType<typeof services>>, id: string) => s.accounts.accountForOwner("user", id);

    it("creates one account for concurrent first use of an owner", async () => {
      const s = await services();
      const rows = await Promise.all(Array.from({ length: 20 }, () => owner(s, "same")));
      expect(new Set(rows.map((row) => row.id)).size).toBe(1);
    });

    it("lets exactly 16 of 50 parallel reservations of 300 succeed on 5,000; available ends at 200", async () => {
      const s = await services();
      const account = await owner(s, "u");
      await s.ledger.grant({ accountId: account.id, kind: "promo", amount: 5_000, sourceRef: "promo:5000", expiresAt: null });
      const results = await Promise.allSettled(Array.from({ length: 50 }, () => s.ledger.reserve(reserve(account.id, 300))));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(16);
      expect((await s.ledger.balance(account.id, ctx(false))).available).toBe(200);
    });

    it("lets only one of a settle and a release of the same reservation win", async () => {
      const s = await services();
      const account = await owner(s, "u");
      await s.ledger.grant({ accountId: account.id, kind: "promo", amount: 1_000, sourceRef: "promo:1000", expiresAt: null });
      const { reservation } = await s.ledger.reserve(reserve(account.id, 300));
      const [settled, released] = await Promise.all([
        s.ledger.settle({ reservationId: reservation.id, credits: 200, idempotencyKey: `job:${reservation.subjectId}:settle`, context: ctx(false) }),
        s.ledger.release({ reservationId: reservation.id, reason: "contract" }),
      ]);
      const winners = [settled.outcome === "settled", released.outcome === "released"].filter(Boolean);
      expect(winners).toHaveLength(1);
      const available = (await s.ledger.balance(account.id, ctx(false))).available;
      expect(available).toBe(settled.outcome === "settled" ? 800 : 1_000);
    });

    it("lets exactly 10 of 200 parallel quota consumes through with a limit of 10", async () => {
      const s = await services();
      const account = await owner(s, "u");
      const view = await s.entitlements.forAccount(account.id);
      const results = await Promise.all(Array.from({ length: 200 }, () => s.quota.consume("mcp.tool_calls", account.id, view.entitlements)));
      expect(results.filter((result) => result.allowed)).toHaveLength(10);
    });

    it("claims one export per rolling window and restores the earlier one on release", async () => {
      const s = await services();
      const account = await owner(s, "exp");
      const hour = 60 * 60 * 1000;
      const t0 = new Date("2026-11-16T10:30:00.000Z");
      expect(await s.store.readLastExport(account.id)).toBeNull();
      expect(await s.store.claimExport({ accountId: account.id, now: t0, windowMs: hour })).toEqual({ claimed: true, at: t0 });
      const early = new Date(t0.getTime() + hour - 1);
      expect(await s.store.claimExport({ accountId: account.id, now: early, windowMs: hour })).toEqual({ claimed: false, lastExportAt: t0 });
      const t1 = new Date(t0.getTime() + hour);
      expect(await s.store.claimExport({ accountId: account.id, now: t1, windowMs: hour })).toEqual({ claimed: true, at: t1 });
      // A release of the old claim changes nothing: a newer claim replaced it.
      await s.store.releaseExport({ accountId: account.id, at: t0 });
      expect(await s.store.readLastExport(account.id)).toEqual(t1);
      await s.store.releaseExport({ accountId: account.id, at: t1 });
      expect(await s.store.readLastExport(account.id)).toEqual(t0);
      // A second release finds no matching claim.
      await s.store.releaseExport({ accountId: account.id, at: t1 });
      expect(await s.store.readLastExport(account.id)).toEqual(t0);
    });

    it("lets exactly one of 20 parallel export claims pass", async () => {
      const s = await services();
      const account = await owner(s, "exp-race");
      const now = new Date("2026-11-16T10:30:00.000Z");
      const results = await Promise.all(
        Array.from({ length: 20 }, () => s.store.claimExport({ accountId: account.id, now, windowMs: 24 * 60 * 60 * 1000 })),
      );
      expect(results.filter((result) => result.claimed)).toHaveLength(1);
    });

    it("frees the window when the only export claim is released", async () => {
      const s = await services();
      const account = await owner(s, "exp-free");
      const now = new Date("2026-11-16T10:30:00.000Z");
      const windowMs = 24 * 60 * 60 * 1000;
      await s.store.claimExport({ accountId: account.id, now, windowMs });
      await s.store.releaseExport({ accountId: account.id, at: now });
      expect(await s.store.readLastExport(account.id)).toBeNull();
      expect((await s.store.claimExport({ accountId: account.id, now, windowMs })).claimed).toBe(true);
    });

    it("gives exactly 50 of 60 parallel founder holds a slot", async () => {
      const s = await services();
      const accounts = await Promise.all(Array.from({ length: 60 }, (_, index) => owner(s, `f${index}`)));
      const results = await Promise.all(accounts.map((account) => s.offers.hold({ offerKey: "founder_v1", accountId: account.id })));
      expect(results.filter((result) => result.granted)).toHaveLength(50);
    });

    it("sends one stop signal for 24 parallel accrual streams on an account that runs out", async () => {
      const s = await services();
      const account = await owner(s, "u");
      await s.ledger.grant({ accountId: account.id, kind: "promo", amount: 1_200, sourceRef: "promo:1200", expiresAt: null });
      const subject = { kind: "job", id: "streams" };
      await s.meter.open({ accountId: account.id, actionKey: "generation.run", subject });
      const stops: (string | null)[] = [];
      await Promise.all(
        Array.from({ length: 24 }, async (_, stream) => {
          for (let call = 0; call < 6; call += 1) {
            if (!(await s.meter.status(subject)).active) return;
            stops.push((await s.meter.accrue({ subject, callId: `s${stream}:c${call}`, costUsd: 0.02 })).stop);
          }
        }),
      );
      const reservation = await s.store.findReservationBySubject("job", "streams");
      expect(reservation?.stopReason).toBe("credits_exhausted");
      const result = await s.meter.settle({ subject, outcome: "stopped" });
      expect(result.charged + result.shortfall).toBe(result.price);
      expect((await s.ledger.balance(account.id, ctx(false))).available).toBeGreaterThanOrEqual(0);
    });

    it("keeps the debt within maxDebt + one margin for 10 parallel pay-as-you-go runs, one usage report each", async () => {
      const s = await services();
      const account = await owner(s, "u");
      await s.store.insertOverride({ accountId: account.id, key: "ai.payg", value: true, reason: "contract", startsAt: null, expiresAt: null, createdBy: "contract" }, s.clock.now());
      await Promise.all(
        Array.from({ length: 10 }, async (_, run) => {
          const subject = { kind: "job", id: `payg${run}` };
          const opened = await s.meter.open({ accountId: account.id, actionKey: "doxabot.run", subject }).catch(() => null);
          if (!opened) return;
          for (let call = 0; call < 5; call += 1) await s.meter.accrue({ subject, callId: `p${run}:${call}`, costUsd: 0.1 });
          await s.meter.settle({ subject, outcome: "pages_changed" });
        }),
      );
      const view = await s.entitlements.forAccount(account.id);
      const balance = await s.ledger.balance(account.id, view.creditContext);
      expect(balance.openDebt).toBeLessThanOrEqual(s.catalog.payg.maxDebtCredits + s.catalog.actions["doxabot.run"].pricing.inFlightMarginCredits);
      const reports = await s.store.listPendingUsageReports(100);
      const identifiers = reports.map((row) => row.identifier);
      expect(new Set(identifiers).size).toBe(identifiers.length);
      expect(reports.reduce((sum, row) => sum + row.credits, 0)).toBe(balance.openDebt);
    });

    it("sums the debt entries of the given reservations only", async () => {
      const s = await services();
      const account = await owner(s, "u");
      await s.store.insertOverride({ accountId: account.id, key: "ai.payg", value: true, reason: "contract", startsAt: null, expiresAt: null, createdBy: "contract" }, s.clock.now());
      const settleRun = async (id: string) => {
        const subject = { kind: "job", id };
        await s.meter.open({ accountId: account.id, actionKey: "doxabot.run", subject, estimateCredits: 0 });
        await s.meter.accrue({ subject, callId: `${id}:c1`, costUsd: 0.1 });
        await s.meter.settle({ subject, outcome: "pages_changed" });
        return (await s.store.findReservationBySubject("job", id))!;
      };
      const first = await settleRun("debt_a");
      const second = await settleRun("debt_b");
      // No grants: pay-as-you-go pays all of each charge.
      expect(await s.store.sumDebtCredits([first.id])).toBe(first.settledAmount);
      expect(await s.store.sumDebtCredits([first.id, second.id])).toBe((first.settledAmount ?? 0) + (second.settledAmount ?? 0));
      expect(await s.store.sumDebtCredits([])).toBe(0);
      expect(await s.store.sumDebtCredits(["00000000-0000-4000-8000-000000000000"])).toBe(0);
    });

    it("charges an accrual that commits while the settle waits for the lock, and none after it", async () => {
      const s = await services();
      const account = await owner(s, "u");
      await s.ledger.grant({ accountId: account.id, kind: "promo", amount: 5_000, sourceRef: "promo:5000", expiresAt: null });
      const subject = { kind: "job", id: "race" };
      await s.meter.open({ accountId: account.id, actionKey: "generation.run", subject });
      await s.meter.accrue({ subject, callId: "c0", costUsd: 0.1 });
      const [settled] = await Promise.all([
        s.meter.settle({ subject, outcome: "succeeded" }),
        ...Array.from({ length: 8 }, (_, call) => s.meter.accrue({ subject, callId: `c${call + 1}`, costUsd: 0.1 })),
      ]);
      const reservation = await s.store.findReservationBySubject("job", "race");
      // The settle priced the row it locked: every accrual before it is in the
      // price, every one after it was refused as late and changed nothing.
      const [head] = (await s.store.listLedgerEntries(account.id, { limit: 100 })).items.filter((entry) => entry.idempotencyKey === "job:race:settle#0");
      expect(head?.metadata.modelCostUsd).toBe(formatUsd12(reservation!.consumedCostPico));
      expect(settled.outcome).toBe("settled");
    });

    it("lists a subject's reservations oldest first and settles every held one", async () => {
      const s = await services();
      const account = await owner(s, "u");
      await s.ledger.grant({ accountId: account.id, kind: "promo", amount: 5_000, sourceRef: "promo:5000", expiresAt: null });
      const subject = { kind: "job", id: "resumed" };
      const first = await s.meter.open({ accountId: account.id, actionKey: "generation.run", subject });
      if (first.kind !== "reserved") throw new Error("the first admission holds credits");
      s.clock.advance(1_000);
      // A second admission is refused while the first one holds credits.
      await expect(
        s.meter.open({ accountId: account.id, actionKey: "generation.run", subject, idempotencyKey: "job:resumed:reserve:2" }),
      ).rejects.toMatchObject({ code: "reservation_in_use" });
      // A second hold left from before that rule.
      const second = await insertLegacyHeldReservation(s.store, first.reservation, {
        idempotencyKey: "job:resumed:reserve:2",
        baseCredits: 0,
        amount: 400,
        at: s.clock.now(),
      });
      const rows = await s.store.listReservationsBySubject("job", "resumed");
      expect(rows.map((row) => row.id)).toEqual([first.reservation.id, second.id]);
      await s.meter.settle({ subject, outcome: "succeeded" });
      expect((await s.store.listReservationsBySubject("job", "resumed")).map((row) => row.status)).toEqual(["settled", "settled"]);
      expect((await s.ledger.balance(account.id, ctx(false))).held).toBe(0);
    });

    it("stores the open Checkout and the swept window, and counts offer slots without the lock", async () => {
      const s = await services();
      const account = await owner(s, "u");
      expect(account).toMatchObject({ openCheckout: null, paygSweptWindowStart: null });
      expect(await s.store.countOfferTaken("founder_v1", s.clock.now())).toBe(0);
      const expiresAt = new Date(s.clock.now().getTime() + 60_000);
      await s.store.withAccountLock(account.id, s.clock.now(), (tx) =>
        tx.updateAccount({ openCheckout: { checkoutId: null, priceKey: "pro_monthly_v1", expiresAt }, paygSweptWindowStart: TEST_NOW }),
      );
      expect(await s.store.getAccount(account.id)).toMatchObject({
        openCheckout: { checkoutId: null, priceKey: "pro_monthly_v1", expiresAt },
        paygSweptWindowStart: TEST_NOW,
      });
      await s.store.withAccountLock(account.id, s.clock.now(), (tx) => tx.updateAccount({ openCheckout: null }));
      expect((await s.store.getAccount(account.id))?.openCheckout).toBeNull();
      await s.offers.hold({ offerKey: "founder_v1", accountId: account.id });
      expect(await s.store.countOfferTaken("founder_v1", s.clock.now())).toBe(1);
      expect(await s.store.countOfferTaken("founder_v1", new Date(s.clock.now().getTime() + 60 * 60_000))).toBe(0);
    });

    it("rolls back every write of a transaction that throws", async () => {
      const s = await services();
      const account = await owner(s, "u");
      await expect(
        s.store.withAccountLock(account.id, s.clock.now(), async (tx) => {
          await tx.insertGrant({ kind: "promo", amount: 10, startsAt: tx.now, expiresAt: null, sourceRef: "promo:rollback" });
          await tx.updateAccount({ paygEnabled: false });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(await s.store.listGrants(account.id)).toEqual([]);
      expect((await s.store.getAccount(account.id))?.paygEnabled).toBe(true);
    });
  });
}
