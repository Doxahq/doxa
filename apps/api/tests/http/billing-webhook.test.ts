import { MEMORY_SIGNATURE_HEADER } from "@doxahq/billing/testing";
import type { RawWebhook } from "@doxahq/billing";
import { describe, expect, test, vi } from "vitest";
import { createApiRouter } from "../../src/http/app";
import { enforceMutationCsrf } from "../../src/http/csrf";
import { createBillingHarness } from "../support/billing-harness";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const { createBillingRoutes } = await import("../../src/routes/billing");

const PATH = "/billing/webhooks/stripe";

/**
 * The route serves only the Stripe provider. These tests drive the memory
 * provider's signed webhooks through a runtime named `stripe`; `asProvider`
 * keeps the memory name to check that the route refuses it.
 */
function setup(options: { payments?: boolean; provider?: "memory" | "none"; asProvider?: "stripe" | "memory" } = {}) {
  const harness = createBillingHarness({ provider: options.provider ?? "memory" });
  const app = createApiRouter();
  app.route(
    "/billing",
    createBillingRoutes(() => {
      const services = harness.services({ payments: options.payments });
      const named = (options.asProvider ?? "stripe") === "stripe" && services.payments?.providerName === "memory";
      return named && services.payments ? { ...services, payments: { ...services.payments, providerName: "stripe" } } : services;
    }),
  );
  const deliver = (raw: RawWebhook) =>
    app.request(`https://api.doxa.so${PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...Object.fromEntries(Object.entries(raw.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")) },
      body: raw.body,
    });
  return { harness, deliver };
}

/** A paid customer whose account exists, so a `customer.changed` event has work. */
async function customerOf(harness: ReturnType<typeof createBillingHarness>) {
  const account = await harness.core.accounts.accountForOwner("user", "user-1");
  const customer = await harness.billing.provider.ensureCustomer({
    accountId: account.id,
    email: null,
    name: null,
    existing: null,
    idempotencyKey: `customer:${account.id}`,
  });
  await harness.core.store.withAccountLock(account.id, harness.billing.clock.now(), (tx) =>
    tx.updateAccount({ provider: customer.provider, providerCustomerId: customer.customerId }),
  );
  return { account, customer };
}

describe("POST /billing/webhooks/stripe (billing spec 14.1)", () => {
  test("a bad signature answers 400 and stores nothing", async () => {
    const { harness, deliver } = setup();
    const { customer } = await customerOf(harness);
    const event = { id: "evt_bad", type: "customer.changed", providerType: "customer.subscription.updated", occurredAt: harness.billing.clock.now(), customer } as const;
    const signed = harness.billing.provider.signEvent(event);
    const forged = { ...signed, headers: { [MEMORY_SIGNATURE_HEADER]: "t=1,v1=00000000" } };
    const response = await deliver(forged);
    expect(response.status).toBe(400);
    expect(await harness.core.store.getProviderEvent("memory", "evt_bad")).toBeNull();
    expect((await deliver({ body: signed.body, headers: {} })).status).toBe(400);
  });

  test("processes a signed event once; a duplicate answers 200 at once", async () => {
    const { harness, deliver } = setup();
    const { customer } = await customerOf(harness);
    const event = { id: "evt_1", type: "customer.changed", providerType: "customer.subscription.updated", occurredAt: harness.billing.clock.now(), customer } as const;
    const raw = harness.billing.provider.signEvent(event);
    const first = await deliver(raw);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    expect(await harness.core.store.getProviderEvent("memory", "evt_1")).toMatchObject({ status: "processed" });
    const again = await deliver(raw);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
  });

  test("a processing failure answers 500, so the provider retries, and the retry succeeds", async () => {
    const { harness, deliver } = setup();
    const { customer } = await customerOf(harness);
    const event = { id: "evt_fail", type: "customer.changed", providerType: "customer.subscription.updated", occurredAt: harness.billing.clock.now(), customer } as const;
    const raw = harness.billing.provider.signEvent(event);
    harness.billing.provider.failNext("fetchCustomerState");
    const failed = await deliver(raw);
    expect(failed.status).toBe(500);
    expect(await harness.core.store.getProviderEvent("memory", "evt_fail")).toMatchObject({ status: "failed" });
    expect((await deliver(raw)).status).toBe(200);
  });

  test("a body over 1 MB answers 413", async () => {
    const { deliver } = setup();
    expect((await deliver({ body: "x".repeat(1024 * 1024 + 1), headers: {} })).status).toBe(413);
  });

  test("answers 404 without a provider that signs webhooks", async () => {
    expect((await setup({ payments: false }).deliver({ body: "{}", headers: {} })).status).toBe(404);
    expect((await setup({ provider: "none" }).deliver({ body: "{}", headers: {} })).status).toBe(404);
  });

  test("refuses the memory provider: its webhook secret is public", async () => {
    const { harness, deliver } = setup({ asProvider: "memory" });
    const { customer } = await customerOf(harness);
    const event = { id: "evt_memory", type: "customer.changed", providerType: "customer.subscription.updated", occurredAt: harness.billing.clock.now(), customer } as const;
    expect((await deliver(harness.billing.provider.signEvent(event))).status).toBe(404);
    expect(await harness.core.store.getProviderEvent("memory", "evt_memory")).toBeNull();
  });

  test("is exempt from the CSRF origin check", () => {
    const request = new Request(`https://api.doxa.so${PATH}`, { method: "POST", headers: { "sec-fetch-site": "cross-site" } });
    expect(enforceMutationCsrf(request, {} as never, PATH)).toBeNull();
    expect(enforceMutationCsrf(request, {} as never, "/billing/accounts/x/checkout")).not.toBeNull();
  });
});
