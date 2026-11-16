import { describe, expect, it } from "vitest";

import { BillingInputError } from "../src/index";
import { createTestBilling } from "../src/testing";

async function checkout(returnPath?: string | null) {
  const billing = createTestBilling();
  const account = await billing.accounts.accountForOwner("user", "u1");
  await billing.payments.createCheckout({ accountId: account.id, priceKey: "pro_monthly_v1", requestId: "r1", returnPath });
  const request = billing.provider.checkoutRequests.at(-1);
  if (!request) throw new Error("No Checkout request.");
  return { account, request };
}

describe("Checkout return URLs", () => {
  it("returns to the billing page without a returnPath, as before", async () => {
    for (const returnPath of [undefined, null]) {
      const { account, request } = await checkout(returnPath);
      expect(request.successUrl).toBe(`https://doxa.test/dashboard/billing/${account.id}?checkout={CHECKOUT_ID}`);
      expect(request.cancelUrl).toBe(`https://doxa.test/dashboard/billing/${account.id}`);
      expect(request.idempotencyKey).toMatch(new RegExp(`^checkout:${account.id}:pro_monthly_v1:r1:\\d+$`));
    }
  });

  it("returns to the dashboard path, adding the checkout parameter to its query", async () => {
    const { request } = await checkout("/dashboard/projects/new?start=repository");
    expect(request.successUrl).toBe("https://doxa.test/dashboard/projects/new?start=repository&checkout={CHECKOUT_ID}");
    expect(request.cancelUrl).toBe("https://doxa.test/dashboard/projects/new?start=repository");
  });

  it("uses ? for a path without a query, and drops a stale checkout parameter", async () => {
    const plain = await checkout("/dashboard/projects/p1/overview");
    expect(plain.request.successUrl).toBe("https://doxa.test/dashboard/projects/p1/overview?checkout={CHECKOUT_ID}");
    expect(plain.request.cancelUrl).toBe("https://doxa.test/dashboard/projects/p1/overview");

    const stale = await checkout("/dashboard/projects/p1/doxabot?checkout=cs_old&tab=a");
    expect(stale.request.successUrl).toBe("https://doxa.test/dashboard/projects/p1/doxabot?tab=a&checkout={CHECKOUT_ID}");
    expect(stale.request.cancelUrl).toBe("https://doxa.test/dashboard/projects/p1/doxabot?tab=a");
  });

  it("refuses every path that could leave the dashboard", async () => {
    const billing = createTestBilling();
    const account = await billing.accounts.accountForOwner("user", "u1");
    const bad = [
      "https://evil.com/dashboard/x",
      "//evil.com/dashboard/",
      "/\\evil.com",
      "/dashboard/\\evil",
      "/dashboard//evil.com",
      "/settings",
      "/dashboard",
      "/dashboard/../login",
      "/dashboard/%2e%2e/login",
      "/dashboard/x\nSet-Cookie: a",
      "/dashboard/x\u0000",
      `/dashboard/${"a".repeat(512)}`,
      "",
    ];
    for (const returnPath of bad) {
      const error = await billing.payments
        .createCheckout({ accountId: account.id, priceKey: "pro_monthly_v1", requestId: "r1", returnPath })
        .catch((caught: unknown) => caught);
      expect(error, returnPath).toBeInstanceOf(BillingInputError);
      expect((error as BillingInputError).code).toBe("invalid_return_path");
    }
    expect(billing.provider.checkoutRequests).toHaveLength(0);
  });
});
