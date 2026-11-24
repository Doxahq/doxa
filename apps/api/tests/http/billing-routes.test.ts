import {
  billingAccountDetailSchema,
  billingAccountListSchema,
  billingInvoicePageSchema,
  billingLedgerPageSchema,
  billingOffersSchema,
  billingPlanIntervalPreviewSchema,
  billingStartProNowPreviewSchema,
  creditEstimateSchema,
} from "@doxahq/contracts/billing";
import { DAY_MS } from "@doxahq/billing";
import { MEMORY_TEST_CARD, subscriptionFixture } from "@doxahq/billing/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createApiRouter } from "../../src/http/app";
import { MembershipProjectAccessPolicy } from "../../src/services/agent-access/membership-project-access-policy";
import { createBillingHarness, type BillingHarness } from "../support/billing-harness";
import { InMemoryProjectAccess } from "../support/in-memory-project-access";

const session = vi.hoisted(() => ({ userId: "user-1" as string | null }));
vi.mock("../../src/http/auth", () => ({
  withUser: (_context: unknown, handler: (userId: string) => Promise<Response>) =>
    session.userId === null
      ? Promise.resolve(new Response(JSON.stringify({ error: { message: "Authentication required." } }), { status: 401 }))
      : handler(session.userId),
}));
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const { BILLING_PREVIEWS_PER_HOUR, BILLING_SESSIONS_PER_HOUR, createBillingRoutes, createCreditEstimateRoutes, resetBillingOffersCache } = await import(
  "../../src/routes/billing"
);

const OWNER = "user-1";
const STRANGER = "user-2";
const TEAM = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";

function setup(options: { payments?: boolean; provider?: "memory" | "none"; enforcement?: "off" | "shadow" | "on" } = {}) {
  const harness = createBillingHarness({ provider: options.provider ?? "memory", enforcement: options.enforcement ?? "on" });
  const access = new InMemoryProjectAccess({ [PROJECT]: { owner: OWNER } });
  harness.billing.projects.set(PROJECT, { userId: OWNER });
  const app = createApiRouter();
  app.route("/billing", createBillingRoutes(() => harness.services(options)));
  app.route(
    "/projects/:projectId/credit-estimate",
    createCreditEstimateRoutes(
      () => harness.services(options),
      () => new MembershipProjectAccessPolicy(access),
    ),
  );
  const send = (userId: string | null, path: string, method = "GET", body?: unknown) => {
    session.userId = userId;
    return app.request(`https://api.doxa.so${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };
  return { harness, send };
}

async function personalAccountId(harness: BillingHarness, userId = OWNER): Promise<string> {
  return (await harness.core.accounts.accountForOwner("user", userId)).id;
}

beforeEach(() => resetBillingOffersCache());

describe("GET /billing/offers", () => {
  test("is public, cached for 60 seconds, and lists the founder offer", async () => {
    const { send } = setup();
    const response = await send(null, "/billing/offers");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    const { offers } = billingOffersSchema.parse(await response.json());
    expect(offers).toEqual([expect.objectContaining({ offerKey: "founder_v1", open: true, slotsLeft: 50 })]);
  });

  test("is a pure read: no offer lock and no insert", async () => {
    const { harness, send } = setup();
    harness.core.store.withOfferLock = () => {
      throw new Error("GET /billing/offers must not lock or insert the offer row");
    };
    expect((await send(null, "/billing/offers")).status).toBe(200);
  });
});

describe("without a payment provider (BILLING_PROVIDER=none)", () => {
  test.each(["off", "shadow", "on"] as const)("every billing route answers 503 before any store access (enforcement %s)", async (enforcement) => {
    const { harness, send } = setup({ provider: "none", enforcement });
    const touched: string[] = [];
    for (const name of ["ensureAccount", "getAccount", "findAccountByOwner", "withAccountLock", "withOfferLock", "countOfferTaken"] as const) {
      const original = harness.core.store[name].bind(harness.core.store) as (...args: unknown[]) => unknown;
      (harness.core.store as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        touched.push(name);
        return original(...args);
      };
    }
    const id = "acct_1";
    const responses = await Promise.all([
      send(OWNER, "/billing/accounts"),
      send(OWNER, `/billing/accounts/${id}`),
      send(OWNER, `/billing/accounts/${id}/credits/entries`),
      send(OWNER, `/billing/accounts/${id}/invoices`),
      send(OWNER, `/billing/accounts/${id}/checkout`, "POST", { offer: "pro_monthly_founder_v2" }),
      send(OWNER, `/billing/accounts/${id}/portal`, "POST", {}),
      send(OWNER, `/billing/accounts/${id}/payg`, "PUT", { enabled: false }),
      send(OWNER, "/billing/checkout/cs_1/sync", "POST"),
      send(null, "/billing/offers"),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { details: { code: "billing_not_configured" } } });
    }
    expect(touched).toEqual([]);
  });
});

describe("billing account routes", () => {
  test("answer 401 without a session", async () => {
    const { harness, send } = setup();
    const id = await personalAccountId(harness);
    expect((await send(null, "/billing/accounts")).status).toBe(401);
    expect((await send(null, `/billing/accounts/${id}`)).status).toBe(401);
    expect((await send(null, `/billing/accounts/${id}/checkout`, "POST", { offer: "pro_monthly_founder_v2" })).status).toBe(401);
  });

  test("list the personal account and the team accounts the user can read", async () => {
    const { harness, send } = setup();
    harness.teams.add(TEAM, "Acme", { [OWNER]: "admin" });
    harness.teams.add("33333333-3333-4333-8333-333333333333", "Other", { [OWNER]: "editor" });
    const list = billingAccountListSchema.parse(await (await send(OWNER, "/billing/accounts")).json());
    expect(list.enforcement).toBe("on");
    const { accounts } = list;
    expect(accounts).toEqual([
      expect.objectContaining({ ownerKind: "user", ownerId: OWNER, name: null, plan: "free", canManage: true }),
      expect.objectContaining({ ownerKind: "team", ownerId: TEAM, name: "Acme", canManage: true }),
    ]);
  });

  test("list the effective plan, not the cached plan key, and the enforcement mode", async () => {
    const { harness, send } = setup({ enforcement: "shadow" });
    const id = await personalAccountId(harness);
    // A stale cache: the trial ended, but the row still says pro.
    await harness.core.store.withAccountLock(id, harness.billing.clock.now(), (tx) => tx.updateAccount({ planKey: "pro" }));
    const list = billingAccountListSchema.parse(await (await send(OWNER, "/billing/accounts")).json());
    expect(list).toMatchObject({ enforcement: "shadow", accounts: [expect.objectContaining({ id, plan: "free" })] });
  });

  test("read the account with plan, credits, pay-as-you-go and offers", async () => {
    const { harness, send } = setup();
    const id = await personalAccountId(harness);
    const response = await send(OWNER, `/billing/accounts/${id}`);
    expect(response.status).toBe(200);
    const detail = billingAccountDetailSchema.parse(await response.json());
    expect(detail).toMatchObject({ id, plan: "free", subscription: null, canManage: true });
    expect(detail.payg.monthlyLimitRangeCents).toEqual([500, 20_000]);
    expect(detail.offers.map((offer) => offer.offerKey)).toEqual(["founder_v1"]);
    expect(detail.caps.map((cap) => cap.action)).toEqual(["generation.run", "doxabot.run"]);
  });

  test("the detail names the account, the next sweep and an open charge", async () => {
    const { harness, send } = setup();
    const id = await personalAccountId(harness);
    const free = billingAccountDetailSchema.parse(await (await send(OWNER, `/billing/accounts/${id}`)).json());
    expect(free).toMatchObject({ name: null, payg: { nextSweepAt: null, thresholdInvoiceOpen: false } });

    await harness.billing.setSubscription(subscriptionFixture({ accountId: id }));
    const invoice = {
      accountId: id,
      providerInvoiceId: "in_threshold",
      credits: 500,
      amountCents: 500,
      status: "draft" as const,
      reason: "threshold" as const,
      createdAt: harness.billing.clock.now(),
      paidAt: null,
    };
    await harness.core.store.withAccountLock(id, harness.billing.clock.now(), (tx) => tx.upsertPaygInvoice(invoice));
    const charging = billingAccountDetailSchema.parse(await (await send(OWNER, `/billing/accounts/${id}`)).json());
    // The fixture subscription starts at 2026-11-13: the next window starts a month later.
    expect(charging.payg).toMatchObject({ nextSweepAt: "2026-12-13T12:00:00.000Z", thresholdInvoiceOpen: true });

    await harness.core.store.withAccountLock(id, harness.billing.clock.now(), (tx) =>
      tx.upsertPaygInvoice({ ...invoice, status: "paid", paidAt: harness.billing.clock.now() }),
    );
    const paid = billingAccountDetailSchema.parse(await (await send(OWNER, `/billing/accounts/${id}`)).json());
    expect(paid.payg.thresholdInvoiceOpen).toBe(false);

    harness.teams.add(TEAM, "Acme", { [OWNER]: "owner" });
    const team = await harness.core.accounts.accountForOwner("team", TEAM);
    const teamDetail = billingAccountDetailSchema.parse(await (await send(OWNER, `/billing/accounts/${team.id}`)).json());
    expect(teamDetail.name).toBe("Acme");
  });

  test("hide other accounts: 404 for a stranger and for an unknown ID", async () => {
    const { harness, send } = setup();
    const id = await personalAccountId(harness);
    expect((await send(STRANGER, `/billing/accounts/${id}`)).status).toBe(404);
    expect((await send(STRANGER, `/billing/accounts/${id}/invoices`)).status).toBe(404);
    expect((await send(OWNER, "/billing/accounts/acct_9999")).status).toBe(404);
    expect((await send(OWNER, "/billing/accounts/not-an-id")).status).toBe(404);
  });

  test("give team members by role: owner and admin manage, an editor gets 403, a stranger 404", async () => {
    const { harness, send } = setup();
    harness.teams.add(TEAM, "Acme", { [OWNER]: "owner", admin: "admin", editor: "editor" });
    const account = await harness.core.accounts.accountForOwner("team", TEAM);
    expect((await send("admin", `/billing/accounts/${account.id}`)).status).toBe(200);
    expect((await send("editor", `/billing/accounts/${account.id}`)).status).toBe(403);
    expect((await send("editor", `/billing/accounts/${account.id}/payg`, "PUT", { enabled: false })).status).toBe(403);
    expect((await send(STRANGER, `/billing/accounts/${account.id}`)).status).toBe(404);
    const updated = await send("admin", `/billing/accounts/${account.id}/payg`, "PUT", { monthlyLimitCents: 1_000 });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ enabled: true, monthlyLimitCents: 1_000 });
  });

  test("page the credit ledger and the invoices", async () => {
    const { harness, send } = setup();
    const id = await personalAccountId(harness);
    await harness.core.ledger.grant({ accountId: id, kind: "promo", amount: 100, sourceRef: "promo:test", expiresAt: null });
    const entries = billingLedgerPageSchema.parse(await (await send(OWNER, `/billing/accounts/${id}/credits/entries?limit=10`)).json());
    expect(entries.entries).toEqual([expect.objectContaining({ kind: "grant", credits: 100 })]);
    expect((await send(OWNER, `/billing/accounts/${id}/credits/entries?limit=1000`)).status).toBe(400);
    const invoices = billingInvoicePageSchema.parse(await (await send(OWNER, `/billing/accounts/${id}/invoices`)).json());
    expect(invoices).toEqual({ invoices: [], nextCursor: null });
  });
});

describe("PUT /billing/accounts/:accountId/payg and /caps", () => {
  test("refuse a monthly limit outside $5–$200 with 400", async () => {
    const { harness, send } = setup();
    const id = await personalAccountId(harness);
    for (const monthlyLimitCents of [499, 20_001, 12.5]) {
      const response = await send(OWNER, `/billing/accounts/${id}/payg`, "PUT", { monthlyLimitCents });
      expect(response.status).toBe(400);
    }
    expect((await send(OWNER, `/billing/accounts/${id}/payg`, "PUT", {})).status).toBe(400);
    const ok = await send(OWNER, `/billing/accounts/${id}/payg`, "PUT", { enabled: false, monthlyLimitCents: 500 });
    expect(await ok.json()).toEqual({ enabled: false, monthlyLimitCents: 500 });
  });

  test("set a cap inside minCap and maxCap, else 400", async () => {
    const { harness, send } = setup();
    const id = await personalAccountId(harness);
    expect((await send(OWNER, `/billing/accounts/${id}/caps`, "PUT", { action: "generation.run", capCredits: 10 })).status).toBe(400);
    // Above the base fee (50), below the lowest cap (1,000).
    expect((await send(OWNER, `/billing/accounts/${id}/caps`, "PUT", { action: "generation.run", capCredits: 280 })).status).toBe(400);
    expect((await send(OWNER, `/billing/accounts/${id}/caps`, "PUT", { action: "mcp.tool_call", capCredits: 100 })).status).toBe(400);
    expect((await send(OWNER, `/billing/accounts/${id}/caps`, "PUT", { action: "nope", capCredits: 100 })).status).toBe(400);
    const response = await send(OWNER, `/billing/accounts/${id}/caps`, "PUT", { action: "generation.run", capCredits: 1_200 });
    expect(response.status).toBe(200);
    const { caps } = (await response.json()) as { caps: { action: string; capCredits: number; minCap: number }[] };
    expect(caps.find((cap) => cap.action === "generation.run")).toMatchObject({ capCredits: 1_200, minCap: 1_000 });
  });
});

describe("Checkout, Portal and the Checkout return", () => {
  test("Checkout takes an offer key and returns a provider URL that returns to the dashboard", async () => {
    const { harness, send } = setup();
    const id = await personalAccountId(harness);
    const response = await send(OWNER, `/billing/accounts/${id}/checkout`, "POST", { offer: "pro_yearly_founder_v2" });
    expect(response.status).toBe(200);
    const { url } = (await response.json()) as { url: string };
    const success = decodeURIComponent(new URL(url).searchParams.get("success") ?? "");
    expect(success).toMatch(new RegExp(`^https://doxa\\.test/dashboard/billing/${id}\\?checkout=cs_`));
  });

  test("Checkout puts the account owner's contact on the customer, so Checkout shows it locked", async () => {
    const { harness, send } = setup();
    const id = await personalAccountId(harness);
    expect((await send(OWNER, `/billing/accounts/${id}/checkout`, "POST", { offer: "pro_monthly_v1" })).status).toBe(200);
    const customerId = harness.billing.provider.checkoutRequests.at(-1)?.customer.customerId ?? "";
    expect(harness.billing.provider.customerContact(customerId)).toEqual({ email: `user-owner-${OWNER}@example.com`, name: OWNER });
  });

  test("Checkout returns to a dashboard returnPath, with the checkout parameter added to its query", async () => {
    const { harness, send } = setup();
    const id = await personalAccountId(harness);
    const response = await send(OWNER, `/billing/accounts/${id}/checkout`, "POST", {
      offer: "pro_yearly_founder_v2",
      returnPath: "/dashboard/projects/new?start=repository",
    });
    expect(response.status).toBe(200);
    const { url } = (await response.json()) as { url: string };
    const success = decodeURIComponent(new URL(url).searchParams.get("success") ?? "");
    expect(success).toMatch(/^https:\/\/doxa\.test\/dashboard\/projects\/new\?start=repository&checkout=cs_/);
    expect(harness.billing.provider.checkoutRequests.at(-1)?.cancelUrl).toBe("https://doxa.test/dashboard/projects/new?start=repository");
  });

  test("Checkout refuses a returnPath that is not a relative dashboard path", async () => {
    const { harness, send } = setup();
    const id = await personalAccountId(harness);
    const bad = [
      "https://evil.com/dashboard/x",
      "//evil.com",
      "//evil.com/dashboard/x",
      "/\\evil",
      "/dashboard/\\evil",
      "/settings",
      "/dashboard/../login",
      "/dashboard/%2e%2e/login",
      "/dashboard/x\u0007",
      `/dashboard/${"a".repeat(503)}`,
    ];
    for (const returnPath of bad) {
      const response = await send(OWNER, `/billing/accounts/${id}/checkout`, "POST", { offer: "pro_monthly_v1", returnPath });
      expect(response.status, returnPath).toBe(400);
    }
    expect(harness.billing.provider.checkoutRequests).toHaveLength(0);
    // 512 characters is still accepted.
    const longest = `/dashboard/${"a".repeat(501)}`;
    expect(longest).toHaveLength(512);
    expect((await send(OWNER, `/billing/accounts/${id}/checkout`, "POST", { offer: "pro_monthly_v1", returnPath: longest })).status).toBe(200);
  });

  test("Checkout refuses an unknown offer, a stranger and a body with a price amount", async () => {
    const { harness, send } = setup();
    const id = await personalAccountId(harness);
    expect((await send(OWNER, `/billing/accounts/${id}/checkout`, "POST", { offer: "enterprise" })).status).toBe(400);
    expect((await send(OWNER, `/billing/accounts/${id}/checkout`, "POST", { offer: "pro_monthly_v1", amountCents: 1 })).status).toBe(400);
    expect((await send(STRANGER, `/billing/accounts/${id}/checkout`, "POST", { offer: "pro_monthly_v1" })).status).toBe(404);
  });

  test("answers 503 where payments are not built in (Worker builds)", async () => {
    const { harness, send } = setup({ payments: false });
    const id = await personalAccountId(harness);
    const response = await send(OWNER, `/billing/accounts/${id}/checkout`, "POST", { offer: "pro_monthly_founder_v2" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { details: { code: "billing_not_configured" } } });
  });

  test("limits Checkout and Portal sessions to 10 for each account in an hour", async () => {
    const { harness, send } = setup();
    const id = await personalAccountId(harness);
    for (let index = 0; index < BILLING_SESSIONS_PER_HOUR; index += 1) {
      expect((await send(OWNER, `/billing/accounts/${id}/checkout`, "POST", { offer: "pro_monthly_founder_v2" })).status).toBe(200);
    }
    expect((await send(OWNER, `/billing/accounts/${id}/portal`, "POST", {})).status).toBe(429);
    harness.billing.clock.advance(60 * 60 * 1000);
    expect((await send(OWNER, `/billing/accounts/${id}/portal`, "POST", {})).status).toBe(200);
  });

  test("the trial is available only to an account that never had a subscription", async () => {
    const context = setup();
    const fresh = await personalAccountId(context.harness);
    const before = billingAccountDetailSchema.parse(await (await context.send(OWNER, `/billing/accounts/${fresh}`)).json());
    expect(before.trialAvailable).toBe(true);
    const id = await trialingAccount(context);
    const after = billingAccountDetailSchema.parse(await (await context.send(OWNER, `/billing/accounts/${id}`)).json());
    expect(after.trialAvailable).toBe(false);
  });

  test("the Checkout return syncs the account at once, only for a manager of that account", async () => {
    const { harness, send } = setup();
    const id = await personalAccountId(harness);
    const created = await send(OWNER, `/billing/accounts/${id}/checkout`, "POST", { offer: "pro_monthly_founder_v2" });
    const sessionId = new URL(((await created.json()) as { url: string }).url).pathname.split("/").pop() ?? "";
    harness.billing.provider.completeCheckout(sessionId);

    expect((await send(STRANGER, `/billing/checkout/${sessionId}/sync`, "POST")).status).toBe(404);
    expect((await send(OWNER, "/billing/checkout/bad%20id/sync", "POST")).status).toBe(404);
    const synced = await send(OWNER, `/billing/checkout/${sessionId}/sync`, "POST");
    expect(synced.status).toBe(200);
    const detail = billingAccountDetailSchema.parse(await synced.json());
    expect(detail).toMatchObject({ plan: "pro", subscription: { status: "trialing" }, offers: [] });

    // A live subscription goes to the Portal, not to a second Checkout.
    expect((await send(OWNER, `/billing/accounts/${id}/checkout`, "POST", { offer: "pro_monthly_v1" })).status).toBe(409);
    const portal = await send(OWNER, `/billing/accounts/${id}/portal`, "POST", { flow: "payment_method_update" });
    expect(portal.status).toBe(200);
    expect(harness.billing.provider.portalSessions.at(-1)).toMatchObject({ returnUrl: `https://doxa.test/dashboard/billing/${id}`, configuration: "founder" });
  });
});

describe("GET /projects/:projectId/credit-estimate", () => {
  test("gives the default estimate before any run, inside the cap", async () => {
    const { send } = setup();
    const response = await send(OWNER, `/projects/${PROJECT}/credit-estimate?action=generation.run`);
    expect(response.status).toBe(200);
    expect(creditEstimateSchema.parse(await response.json())).toEqual({ action: "generation.run", low: 317, high: 450, cap: 3_000, source: "default" });
  });

  test("uses the median of past settled runs", async () => {
    const { harness, send } = setup();
    const account = await harness.core.accounts.resolveBillingAccount(PROJECT);
    await harness.billing.setSubscription(subscriptionFixture({ accountId: account.id }));
    const view = await harness.core.entitlements.forAccount(account.id);
    const opened = await harness.billing.meter.open({ accountId: account.id, actionKey: "doxabot.run", subject: { kind: "job", id: "job-1" } });
    if (opened.kind !== "reserved") throw new Error("expected a reservation");
    await harness.core.ledger.settle({ reservationId: opened.reservation.id, credits: 120, idempotencyKey: "job:job-1:settle", context: view.creditContext });
    harness.jobIds.set(PROJECT, ["job-1"]);
    const estimate = creditEstimateSchema.parse(await (await send(OWNER, `/projects/${PROJECT}/credit-estimate?action=doxabot.run`)).json());
    expect(estimate).toEqual({ action: "doxabot.run", low: 120, high: 170, cap: 500, source: "history" });
  });

  test("refuses an action without a meter, and a viewer without project access", async () => {
    const { send } = setup();
    expect((await send(OWNER, `/projects/${PROJECT}/credit-estimate?action=mcp.tool_call`)).status).toBe(400);
    expect((await send(OWNER, `/projects/${PROJECT}/credit-estimate`)).status).toBe(400);
    expect((await send(STRANGER, `/projects/${PROJECT}/credit-estimate?action=generation.run`)).status).toBe(404);
  });
});

describe("POST /billing/accounts/:accountId/plan-interval", () => {
  async function subscribed(setupResult: ReturnType<typeof setup>, userId = OWNER) {
    const { harness, send } = setupResult;
    const id = await personalAccountId(harness, userId);
    const created = await send(userId, `/billing/accounts/${id}/checkout`, "POST", { offer: "pro_monthly_founder_v2" });
    const sessionId = new URL(((await created.json()) as { url: string }).url).pathname.split("/").pop() ?? "";
    harness.billing.provider.completeCheckout(sessionId);
    expect((await send(userId, `/billing/checkout/${sessionId}/sync`, "POST")).status).toBe(200);
    return id;
  }

  test("switches monthly to yearly; a founder stays on the founder price, and the account shows it", async () => {
    const context = setup();
    const id = await subscribed(context);
    const response = await context.send(OWNER, `/billing/accounts/${id}/plan-interval`, "POST", { interval: "year" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ priceKey: "pro_yearly_founder_v2" });
    const detail = billingAccountDetailSchema.parse(await (await context.send(OWNER, `/billing/accounts/${id}`)).json());
    expect(detail.subscription?.priceKey).toBe("pro_yearly_founder_v2");
    // The same interval again changes nothing.
    const same = await context.send(OWNER, `/billing/accounts/${id}/plan-interval`, "POST", { interval: "year" });
    expect(await same.json()).toEqual({ priceKey: "pro_yearly_founder_v2" });
  });

  test("needs billing.manage: 403 for a team editor, 404 for a stranger", async () => {
    const { harness, send } = setup();
    harness.teams.add(TEAM, "Acme", { [OWNER]: "owner", editor: "editor" });
    const account = await harness.core.accounts.accountForOwner("team", TEAM);
    expect((await send("editor", `/billing/accounts/${account.id}/plan-interval`, "POST", { interval: "year" })).status).toBe(403);
    expect((await send(STRANGER, `/billing/accounts/${account.id}/plan-interval`, "POST", { interval: "year" })).status).toBe(404);
  });

  test("409 without a subscription, 400 for a bad interval, 503 without payments", async () => {
    const { harness, send } = setup();
    const id = await personalAccountId(harness);
    const none = await send(OWNER, `/billing/accounts/${id}/plan-interval`, "POST", { interval: "year" });
    expect(none.status).toBe(409);
    expect(await none.json()).toMatchObject({ error: { details: { code: "no_subscription" } } });
    expect((await send(OWNER, `/billing/accounts/${id}/plan-interval`, "POST", { interval: "week" })).status).toBe(400);
    const worker = setup({ payments: false });
    const workerId = await personalAccountId(worker.harness);
    expect((await worker.send(OWNER, `/billing/accounts/${workerId}/plan-interval`, "POST", { interval: "year" })).status).toBe(503);
  });
});

/** A personal account in its Pro trial, through Checkout and the Checkout return. */
async function trialingAccount(context: ReturnType<typeof setup>, offer = "pro_monthly_founder_v2"): Promise<string> {
  const { harness, send } = context;
  const id = await personalAccountId(harness);
  const created = await send(OWNER, `/billing/accounts/${id}/checkout`, "POST", { offer });
  const sessionId = new URL(((await created.json()) as { url: string }).url).pathname.split("/").pop() ?? "";
  harness.billing.provider.completeCheckout(sessionId);
  expect((await send(OWNER, `/billing/checkout/${sessionId}/sync`, "POST")).status).toBe(200);
  return id;
}

async function errorCode(response: Response): Promise<unknown> {
  return ((await response.json()) as { error?: { details?: { code?: unknown } } }).error?.details?.code;
}

function customerOf(harness: BillingHarness, accountId: string) {
  return harness.core.store.getAccount(accountId).then((account) => ({ provider: "memory" as const, customerId: account?.providerCustomerId ?? "" }));
}

describe("the card on file in GET /billing/accounts/:accountId", () => {
  test("shows the card that Stripe charges, with one provider call for each read", async () => {
    const context = setup();
    const id = await trialingAccount(context);
    const provider = context.harness.billing.provider;
    const original = provider.fetchPaymentMethod.bind(provider);
    let calls = 0;
    provider.fetchPaymentMethod = (input) => {
      calls += 1;
      return original(input);
    };
    const detail = billingAccountDetailSchema.parse(await (await context.send(OWNER, `/billing/accounts/${id}`)).json());
    expect(detail.paymentMethod).toEqual(MEMORY_TEST_CARD);
    expect(calls).toBe(1);
  });

  test("is null for an account without a customer, and where payments are not built in", async () => {
    const context = setup();
    const id = await personalAccountId(context.harness);
    expect(billingAccountDetailSchema.parse(await (await context.send(OWNER, `/billing/accounts/${id}`)).json()).paymentMethod).toBeNull();
    const worker = setup({ payments: false });
    const workerId = await personalAccountId(worker.harness);
    const detail = billingAccountDetailSchema.parse(await (await worker.send(OWNER, `/billing/accounts/${workerId}`)).json());
    expect(detail.paymentMethod).toBeNull();
  });

  test("a provider failure gives null and a log line, never a 5xx", async () => {
    const context = setup();
    const id = await trialingAccount(context);
    context.harness.billing.provider.failNext("fetchPaymentMethod");
    const response = await context.send(OWNER, `/billing/accounts/${id}`);
    expect(response.status).toBe(200);
    const detail = billingAccountDetailSchema.parse(await response.json());
    expect(detail).toMatchObject({ plan: "pro", paymentMethod: null });
    expect(context.harness.logs).toContainEqual({
      event: "billing.payment_method_unavailable",
      fields: expect.objectContaining({ accountId: id, error: "ProviderUnavailableError" }),
    });
  });
});

describe("Start Pro now (decision D22)", () => {
  test("previews the charge, then ends the trial and answers the synced account with the monthly credits", async () => {
    const context = setup();
    const id = await trialingAccount(context);
    const preview = await context.send(OWNER, `/billing/accounts/${id}/start-pro-now`);
    expect(preview.status).toBe(200);
    expect(billingStartProNowPreviewSchema.parse(await preview.json())).toEqual({ amountCents: 12_900, currency: "usd", intervalLabel: "month" });

    context.harness.billing.clock.advance(2 * DAY_MS);
    const response = await context.send(OWNER, `/billing/accounts/${id}/start-pro-now`, "POST");
    expect(response.status).toBe(200);
    const detail = billingAccountDetailSchema.parse(await response.json());
    expect(detail).toMatchObject({ plan: "pro", subscription: { status: "active" }, paymentMethod: MEMORY_TEST_CARD });
    // The trial credits end; the 10,000 monthly allowance starts now, and
    // pay-as-you-go (off during the trial) adds its 1,000-credit debt room.
    expect(detail.credits).toMatchObject({ granted: 10_000, available: 11_000, allowance: 10_000 });
    expect(detail.payg.active).toBe(true);

    const again = await context.send(OWNER, `/billing/accounts/${id}/start-pro-now`, "POST");
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("not_trialing");
  });

  test("refuses with 409 not_trialing without a trial, and 402 payment_failed for a declined card", async () => {
    const context = setup();
    const free = await personalAccountId(context.harness);
    for (const method of ["GET", "POST"]) {
      const response = await context.send(OWNER, `/billing/accounts/${free}/start-pro-now`, method);
      expect(response.status).toBe(409);
      expect(await errorCode(response)).toBe("not_trialing");
    }
    const id = await trialingAccount(context);
    context.harness.billing.provider.setCardFails(await customerOf(context.harness, id), true);
    const declined = await context.send(OWNER, `/billing/accounts/${id}/start-pro-now`, "POST");
    expect(declined.status).toBe(402);
    expect(await errorCode(declined)).toBe("payment_failed");
    const detail = billingAccountDetailSchema.parse(await (await context.send(OWNER, `/billing/accounts/${id}`)).json());
    expect(detail.subscription?.status).toBe("trialing");
  });

  test("needs billing.manage to start and billing.read to preview: 403 for a team editor, 404 for a stranger, 401 signed out", async () => {
    const { harness, send } = setup();
    harness.teams.add(TEAM, "Acme", { [OWNER]: "owner", editor: "editor" });
    const account = await harness.core.accounts.accountForOwner("team", TEAM);
    for (const method of ["GET", "POST"]) {
      expect((await send("editor", `/billing/accounts/${account.id}/start-pro-now`, method)).status).toBe(403);
      expect((await send(STRANGER, `/billing/accounts/${account.id}/start-pro-now`, method)).status).toBe(404);
      expect((await send(null, `/billing/accounts/${account.id}/start-pro-now`, method)).status).toBe(401);
    }
  });

  test("answers 503 where payments are not built in", async () => {
    const worker = setup({ payments: false });
    const id = await personalAccountId(worker.harness);
    for (const method of ["GET", "POST"]) {
      const response = await worker.send(OWNER, `/billing/accounts/${id}/start-pro-now`, method);
      expect(response.status).toBe(503);
      expect(await errorCode(response)).toBe("billing_not_configured");
    }
  });
});

describe("GET /billing/accounts/:accountId/plan-interval/preview", () => {
  test("previews the switch to yearly through the provider, and changes nothing", async () => {
    const context = setup();
    const id = await trialingAccount(context);
    const response = await context.send(OWNER, `/billing/accounts/${id}/plan-interval/preview?interval=year`);
    expect(response.status).toBe(200);
    const preview = billingPlanIntervalPreviewSchema.parse(await response.json());
    // A trial has paid nothing, so there is no credit for unused time.
    expect(preview).toEqual({ chargeTodayCents: 118_800, creditCents: 0, newPriceCents: 118_800, newInterval: "year", balanceAfterCents: 0 });
    const detail = billingAccountDetailSchema.parse(await (await context.send(OWNER, `/billing/accounts/${id}`)).json());
    expect(detail.subscription?.priceKey).toBe("pro_monthly_founder_v2");
  });

  test("refuses a bad interval (400), the same interval and no subscription (409), and no payments (503)", async () => {
    const context = setup();
    const free = await personalAccountId(context.harness);
    expect((await context.send(OWNER, `/billing/accounts/${free}/plan-interval/preview?interval=week`)).status).toBe(400);
    expect((await context.send(OWNER, `/billing/accounts/${free}/plan-interval/preview`)).status).toBe(400);
    const none = await context.send(OWNER, `/billing/accounts/${free}/plan-interval/preview?interval=year`);
    expect(none.status).toBe(409);
    expect(await errorCode(none)).toBe("no_subscription");
    const id = await trialingAccount(context);
    const same = await context.send(OWNER, `/billing/accounts/${id}/plan-interval/preview?interval=month`);
    expect(same.status).toBe(409);
    expect(await errorCode(same)).toBe("same_interval");
    const worker = setup({ payments: false });
    const workerId = await personalAccountId(worker.harness);
    expect((await worker.send(OWNER, `/billing/accounts/${workerId}/plan-interval/preview?interval=year`)).status).toBe(503);
  });

  test("needs billing.read: 403 for a team editor, 404 for a stranger", async () => {
    const { harness, send } = setup();
    harness.teams.add(TEAM, "Acme", { [OWNER]: "owner", editor: "editor" });
    const account = await harness.core.accounts.accountForOwner("team", TEAM);
    expect((await send("editor", `/billing/accounts/${account.id}/plan-interval/preview?interval=year`)).status).toBe(403);
    expect((await send(STRANGER, `/billing/accounts/${account.id}/plan-interval/preview?interval=year`)).status).toBe(404);
  });

  test("limits provider previews to 60 for each account in an hour", async () => {
    const context = setup();
    const id = await trialingAccount(context);
    for (let index = 0; index < BILLING_PREVIEWS_PER_HOUR; index += 1) {
      expect((await context.send(OWNER, `/billing/accounts/${id}/plan-interval/preview?interval=year`)).status).toBe(200);
    }
    const limited = await context.send(OWNER, `/billing/accounts/${id}/start-pro-now`);
    expect(limited.status).toBe(429);
    expect(await errorCode(limited)).toBe("billing_preview_limit");
  });
});
