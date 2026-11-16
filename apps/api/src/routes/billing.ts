import { isActionKey, type BillingAccount, type RawWebhook } from "@doxahq/billing";
import {
  billingCapInputSchema,
  billingCheckoutInputSchema,
  billingPageQuerySchema,
  billingPaygInputSchema,
  billingPlanIntervalInputSchema,
  billingPlanIntervalPreviewQuerySchema,
  billingPortalInputSchema,
  type BillingAccountList,
  type BillingLedgerPage,
  type BillingAccountDetail,
  type BillingOffers,
  type BillingPlanIntervalPreview,
  type BillingStartProNowPreview,
} from "@doxahq/contracts/billing";
import { createApiRouter, type ApiApp, type ApiContext } from "../http/app";
import { withUser } from "../http/auth";
import { billingErrorResponse } from "../http/billing-errors";
import { readBodyText, requestBodyTooLarge } from "../http/body";
import { RequestBodyTooLarge } from "../http/bounded-body";
import { forbidden, withProjectAccess, type DashboardPolicyFactory } from "../http/project-access";
import { error, json, notFound } from "../http/response";
import { parseValidatedJson } from "../http/validation";
import {
  BillingOwnershipRepository,
  type BillingContactDirectory,
  type BillingRunHistory,
} from "../repositories/billing-ownership";
import { TeamsRepository } from "../repositories/teams";
import { BillingAccountAccess, type BillingCapability } from "../services/billing/account-access";
import { describeOffers, estimateProjectRun, readAccountDetail, toInvoicePage, toLedgerEntryDto } from "../services/billing/account-view";
import { billingCoreFromEnv, type BillingCore } from "../services/billing/core";
import type { BillingPaymentsRuntime } from "../services/billing/payments-port";

/** What the billing routes use. Tests pass the memory store and the memory provider. */
export interface BillingRouteServices {
  readonly core: BillingCore;
  readonly access: BillingAccountAccess;
  /** Null outside the Node origin: Checkout, Portal, invoices and webhooks need `@doxahq/billing/payments`. */
  readonly payments: BillingPaymentsRuntime | null;
  readonly contacts: BillingContactDirectory;
  readonly history: BillingRunHistory;
}

export type BillingRouteFactory = (context: ApiContext) => BillingRouteServices;

export const billingServicesFromEnv: BillingRouteFactory = (context) => {
  const env = context.env;
  const core = billingCoreFromEnv(env);
  const ownership = new BillingOwnershipRepository(env);
  return {
    core,
    access: new BillingAccountAccess({
      store: core.store,
      accounts: core.accounts,
      teams: new TeamsRepository(env),
      acceptsAccountId: core.acceptsAccountId,
    }),
    payments: env.BILLING_PAYMENTS?.forEnv(env) ?? null,
    contacts: ownership,
    history: ownership,
  };
};

/** Billing spec 17: 10 Checkout or Portal sessions (and Start Pro now charges) for each account in one hour. */
export const BILLING_SESSIONS_PER_HOUR = 10;
const SESSION_METER = "billing.sessions";
/** Provider invoice previews (plan switch, Start Pro now) for each account in one hour. */
export const BILLING_PREVIEWS_PER_HOUR = 60;
const PREVIEW_METER = "billing.previews";
const HOUR_MS = 60 * 60 * 1000;
/** `GET /billing/offers` is public and cached 60 seconds (spec 15.1). */
const OFFERS_TTL_MS = 60_000;
/** Billing spec 14.1 step 1. */
const WEBHOOK_BODY_MAX_BYTES = 1024 * 1024;
/** A provider Checkout Session ID, such as `cs_test_...`. */
const CHECKOUT_ID = /^[A-Za-z0-9_]{1,255}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

let offersCache: { at: number; body: BillingOffers } | null = null;

/** For tests: forget the cached offers. */
export function resetBillingOffersCache(): void {
  offersCache = null;
}

/**
 * `/billing` (billing spec 15.1). Every account route resolves the account
 * from the URL and checks the viewer's access to it (spec 17); the client
 * never names a plan, a price ID or an amount. There is no pay-now route
 * (decision D19): charges are automatic only.
 */
export function createBillingRoutes(services: BillingRouteFactory = billingServicesFromEnv): ApiApp {
  const app = createApiRouter();

  app.get("/offers", async (context) =>
    guard(context, services, null, async (billing) => {
      const now = billing.core.clock.now().getTime();
      if (!offersCache || now - offersCache.at >= OFFERS_TTL_MS) {
        offersCache = { at: now, body: { offers: await describeOffers(billing.core) } };
      }
      return json(offersCache.body, { headers: { "cache-control": "public, max-age=60" } });
    }),
  );

  // Billing spec 14.1. CSRF-exempt and not rate limited at the edge: the signature authenticates it.
  app.post("/webhooks/stripe", (context) =>
    guard(context, services, null, { needsProvider: false }, async (billing) => {
      const runtime = billing.payments;
      // Only the Stripe provider: the memory provider (tests) signs with a public secret.
      if (!runtime || runtime.providerName !== "stripe") return notFound();
      let body: string;
      try {
        body = await readBodyText(context.req.raw, WEBHOOK_BODY_MAX_BYTES);
      } catch (cause) {
        if (cause instanceof RequestBodyTooLarge) return requestBodyTooLarge();
        throw cause;
      }
      const headers: Record<string, string> = {};
      context.req.raw.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      const raw: RawWebhook = { body, headers };
      const result = await runtime.handleWebhook(raw);
      return json(result.body, { status: result.status });
    }),
  );

  app.get("/accounts", (context) =>
    withUser(context, (userId) =>
      guard(context, services, null, async (billing) => {
        const accounts = await billing.access.list(userId);
        const body: BillingAccountList = {
          // The dashboard gates AI and limits only when this is `on`.
          enforcement: billing.core.config.enforcement,
          accounts: await Promise.all(
            accounts.map(async ({ account, name, canManage }) => ({
              id: account.id,
              ownerKind: account.ownerKind,
              ownerId: account.ownerId ?? "",
              name,
              // The effective plan, not the cached `plan_key` (a trial that ended, an override).
              plan: (await billing.core.entitlements.forAccount(account.id)).entitlements.plan,
              canManage,
            })),
          ),
        };
        return json(body);
      }),
    ),
  );

  app.get("/accounts/:accountId", (context) =>
    withAccount(context, services, "billing.read", async (billing, { account, canManage, userId }) =>
      json(await accountDetail(billing, userId, account, canManage)),
    ),
  );

  app.get("/accounts/:accountId/credits/entries", (context) =>
    withAccount(context, services, "billing.read", async (billing, { account }) => {
      const query = billingPageQuerySchema.safeParse(context.req.query());
      if (!query.success) return error("Invalid page.", 400, query.error.flatten());
      const page = await billing.core.store.listLedgerEntries(account.id, { limit: query.data.limit, cursor: query.data.cursor ?? null });
      const body: BillingLedgerPage = { entries: page.items.map(toLedgerEntryDto), nextCursor: page.nextCursor };
      return json(body);
    }),
  );

  app.get("/accounts/:accountId/invoices", (context) =>
    withAccount(context, services, "billing.read", async (billing, { account }) => {
      const query = billingPageQuerySchema.safeParse(context.req.query());
      if (!query.success) return error("Invalid page.", 400, query.error.flatten());
      if (!billing.payments) return json({ invoices: [], nextCursor: null });
      const page = await billing.payments.listInvoices({ accountId: account.id, limit: query.data.limit, cursor: query.data.cursor ?? null });
      return json(toInvoicePage(page));
    }),
  );

  app.post("/accounts/:accountId/checkout", (context) =>
    withAccount(context, services, "billing.manage", async (billing, { account }) => {
      const input = await parseValidatedJson(context, billingCheckoutInputSchema, "Invalid checkout.");
      if (!input.ok) return input.response;
      const payments = requirePayments(billing);
      const limited = await sessionLimit(billing, account.id);
      if (limited) return limited;
      // The owner's contact, not the caller's: an admin who opens a team's Checkout pays with the team's email.
      const contact = await billing.contacts.billingContactOf(account);
      const link = await payments.createCheckout({
        accountId: account.id,
        priceKey: input.data.offer,
        requestId: requestIdOf(context),
        email: contact?.email ?? null,
        name: contact?.name ?? null,
        // A dashboard path only; the payments service checks it again against the dashboard origin.
        returnPath: input.data.returnPath ?? null,
      });
      return json({ url: link.url });
    }),
  );

  app.post("/accounts/:accountId/portal", (context) =>
    withAccount(context, services, "billing.manage", async (billing, { account }) => {
      const input = await parseValidatedJson(context, billingPortalInputSchema, "Invalid portal request.");
      if (!input.ok) return input.response;
      const payments = requirePayments(billing);
      const limited = await sessionLimit(billing, account.id);
      if (limited) return limited;
      const link = await payments.createPortalSession({ accountId: account.id, flow: input.data.flow ?? null });
      return json({ url: link.url });
    }),
  );

  // The monthly/yearly switch: the Portal cannot update a subscription with a
  // usage price, so the dashboard switches through here. Not rate limited as a
  // session: it creates no hosted page, and the provider call is idempotent.
  app.post("/accounts/:accountId/plan-interval", (context) =>
    withAccount(context, services, "billing.manage", async (billing, { account }) => {
      const input = await parseValidatedJson(context, billingPlanIntervalInputSchema, "Invalid plan interval.");
      if (!input.ok) return input.response;
      const payments = requirePayments(billing);
      const result = await payments.switchPlanInterval({
        accountId: account.id,
        interval: input.data.interval,
        requestId: requestIdOf(context),
      });
      return json({ priceKey: result.priceKey });
    }),
  );

  // What the switch above charges now, for its confirm dialog: the provider's
  // invoice preview of the same items and proration. It creates nothing.
  app.get("/accounts/:accountId/plan-interval/preview", (context) =>
    withAccount(context, services, "billing.read", async (billing, { account }) => {
      const query = billingPlanIntervalPreviewQuerySchema.safeParse(context.req.query());
      if (!query.success) return error("Invalid interval.", 400, query.error.flatten());
      const payments = requirePayments(billing);
      const limited = await previewLimit(billing, account.id);
      if (limited) return limited;
      const body: BillingPlanIntervalPreview = await payments.previewPlanInterval({ accountId: account.id, interval: query.data.interval });
      return json(body);
    }),
  );

  // Start Pro now (decision D22): what it charges today, for the confirm dialog.
  app.get("/accounts/:accountId/start-pro-now", (context) =>
    withAccount(context, services, "billing.read", async (billing, { account }) => {
      const payments = requirePayments(billing);
      const limited = await previewLimit(billing, account.id);
      if (limited) return limited;
      const body: BillingStartProNowPreview = await payments.previewStartProNow({ accountId: account.id });
      return json(body);
    }),
  );

  // Start Pro now (decision D22): ends the trial, charges the plan, and answers
  // the synced account, as the Checkout return does. Counted with the sessions:
  // each attempt can charge the card.
  app.post("/accounts/:accountId/start-pro-now", (context) =>
    withAccount(context, services, "billing.manage", async (billing, { account, canManage, userId }) => {
      const payments = requirePayments(billing);
      const limited = await sessionLimit(billing, account.id);
      if (limited) return limited;
      await payments.startProNow({ accountId: account.id, requestId: requestIdOf(context) });
      const updated = (await billing.core.store.getAccount(account.id)) ?? account;
      return json(await accountDetail(billing, userId, updated, canManage));
    }),
  );

  app.put("/accounts/:accountId/payg", (context) =>
    withAccount(context, services, "billing.manage", async (billing, { account }) => {
      const input = await parseValidatedJson(context, billingPaygInputSchema, "Invalid pay-as-you-go settings.");
      if (!input.ok) return input.response;
      const updated = await billing.core.settings.setPayg({ accountId: account.id, ...input.data });
      return json({ enabled: updated.paygEnabled, monthlyLimitCents: updated.paygMonthlyLimitCents });
    }),
  );

  app.put("/accounts/:accountId/caps", (context) =>
    withAccount(context, services, "billing.manage", async (billing, { account }) => {
      const input = await parseValidatedJson(context, billingCapInputSchema, "Invalid cap.");
      if (!input.ok) return input.response;
      if (!isActionKey(input.data.action)) return error("Unknown action.", 400, { code: "action_not_metered" });
      const updated = await billing.core.settings.setCap({
        accountId: account.id,
        actionKey: input.data.action,
        capCredits: input.data.capCredits,
      });
      return json({ caps: (await readAccountDetail(billing.core, updated, true)).caps });
    }),
  );

  // Billing spec 14.2: the Checkout return. The session's account comes from
  // the provider, then the viewer needs `billing.manage` on it.
  app.post("/checkout/:sessionId/sync", (context) =>
    withUser(context, (userId) =>
      guard(context, services, null, async (billing) => {
        const sessionId = context.req.param("sessionId") ?? "";
        if (!CHECKOUT_ID.test(sessionId)) return notFound();
        const payments = requirePayments(billing);
        const checkout = await payments.fetchCheckout(sessionId);
        const accountId =
          checkout.accountId ??
          (checkout.customer
            ? ((await billing.core.store.findAccountByProviderCustomer(checkout.customer.provider, checkout.customer.customerId))?.id ?? null)
            : null);
        if (!accountId) return notFound();
        const decision = await billing.access.authorize(userId, accountId, "billing.manage");
        if (!decision.allowed) return decision.reason === "forbidden" ? billingForbidden() : notFound();
        await payments.syncCheckout(sessionId);
        const account = (await billing.core.store.getAccount(accountId)) ?? decision.account;
        return json(await accountDetail(billing, userId, account, decision.canManage));
      }),
    ),
  );

  return app;
}

/**
 * `GET /projects/:projectId/credit-estimate?action=` (billing spec 15.1),
 * mounted under `/projects/:projectId/credit-estimate`.
 */
export function createCreditEstimateRoutes(
  services: BillingRouteFactory = billingServicesFromEnv,
  policyFor?: DashboardPolicyFactory,
): ApiApp {
  const app = createApiRouter();
  app.get("/", (context) =>
    withProjectAccess(
      context,
      "project.read",
      (access) =>
        // Self-hosted servers meter credits without a payment provider.
        guard(context, services, null, { needsProvider: false }, async (billing) => {
          const action = context.req.query("action") ?? "";
          return json(await estimateProjectRun(billing.core, billing.history, { projectId: access.projectId, action }));
        }),
      policyFor,
    ),
  );
  return app;
}

interface AccountAccessContext {
  readonly userId: string;
  readonly account: BillingAccount;
  readonly canManage: boolean;
}

function withAccount(
  context: ApiContext,
  services: BillingRouteFactory,
  capability: BillingCapability,
  handler: (billing: BillingRouteServices, access: AccountAccessContext) => Promise<Response>,
): Promise<Response> {
  return withUser(context, (userId) => {
    const accountId = context.req.param("accountId") ?? "";
    return guard(context, services, accountId, async (billing) => {
      const decision = await billing.access.authorize(userId, accountId, capability);
      if (!decision.allowed) return decision.reason === "forbidden" ? billingForbidden() : notFound();
      return handler(billing, { userId, account: decision.account, canManage: decision.canManage });
    });
  });
}

/** Thrown when a route needs `BILLING_PAYMENTS` and this build has none. */
class PaymentsUnavailable extends Error {}

/**
 * Builds the services inside the error mapping, so a missing billing store
 * answers 503, not 500.
 *
 * Without a payment provider (`BILLING_PROVIDER=none`, the default) the
 * billing routes answer 503 `billing_not_configured` before any store read
 * or write: no account row is created, and a server where migration 0046 has
 * not run behaves as before billing. The dashboard then hides billing.
 */
async function guard(
  context: ApiContext,
  services: BillingRouteFactory,
  accountId: string | null,
  optionsOrHandler: { readonly needsProvider: boolean } | ((billing: BillingRouteServices) => Promise<Response>),
  maybeHandler?: (billing: BillingRouteServices) => Promise<Response>,
): Promise<Response> {
  const options = typeof optionsOrHandler === "function" ? { needsProvider: true } : optionsOrHandler;
  const handler = typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler!;
  let billing: BillingRouteServices | null = null;
  try {
    billing = services(context);
    if (options.needsProvider && billing.core.config.provider === "none") return billingNotConfigured();
    return await handler(billing);
  } catch (cause) {
    if (cause instanceof PaymentsUnavailable) return billingNotConfigured();
    const response = billingErrorResponse(cause, { returnBaseUrl: billing?.core.config.returnBaseUrl ?? null, accountId });
    if (response) return response;
    throw cause;
  }
}

function billingNotConfigured(): Response {
  return error("Payments are not available on this server.", 503, { code: "billing_not_configured" });
}

function requirePayments(billing: BillingRouteServices): BillingPaymentsRuntime {
  if (!billing.payments) throw new PaymentsUnavailable();
  return billing.payments;
}

/** The account detail with the viewer's name for the account and, on the Node origin, the card on file. */
async function accountDetail(billing: BillingRouteServices, userId: string, account: BillingAccount, canManage: boolean): Promise<BillingAccountDetail> {
  return readAccountDetail(billing.core, account, canManage, { name: await billing.access.nameOf(userId, account), payments: billing.payments });
}

function sessionLimit(billing: BillingRouteServices, accountId: string): Promise<Response | null> {
  return hourlyLimit(billing, accountId, SESSION_METER, BILLING_SESSIONS_PER_HOUR, {
    code: "billing_session_limit",
    message: "Too many billing sessions for this account. Try again in an hour.",
  });
}

function previewLimit(billing: BillingRouteServices, accountId: string): Promise<Response | null> {
  return hourlyLimit(billing, accountId, PREVIEW_METER, BILLING_PREVIEWS_PER_HOUR, {
    code: "billing_preview_limit",
    message: "Too many price previews for this account. Try again in an hour.",
  });
}

/** A fixed one-hour window counter for each account: 429 with `resetsAt` above `max`. */
async function hourlyLimit(
  billing: BillingRouteServices,
  accountId: string,
  meterKey: string,
  max: number,
  refusal: { readonly code: string; readonly message: string },
): Promise<Response | null> {
  const now = billing.core.clock.now().getTime();
  const windowStart = new Date(now - (now % HOUR_MS));
  const count = await billing.core.store.incrementUsageCounter({ accountId, meterKey, windowStart });
  if (count <= max) return null;
  return error(refusal.message, 429, { code: refusal.code, resetsAt: new Date(windowStart.getTime() + HOUR_MS).toISOString() });
}

function requestIdOf(context: ApiContext): string {
  const header = context.req.header("idempotency-key")?.trim();
  return header && IDEMPOTENCY_KEY.test(header) ? header : crypto.randomUUID();
}

function billingForbidden(): Response {
  return forbidden("Only the account owner, or a team owner or admin, can do this.");
}

