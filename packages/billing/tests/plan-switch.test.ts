import { describe, expect, it } from "vitest";

import { createTestBilling } from "../src/testing";
import { paidProAccount } from "./helpers/pro";

describe("monthly/yearly plan switch", () => {
  it("moves a regular monthly subscription to the yearly price and its yearly usage price", async () => {
    const billing = createTestBilling();
    const { account, customer } = await paidProAccount(billing);
    const result = await billing.payments.switchPlanInterval({ accountId: account.id, interval: "year", requestId: "s1" });
    expect(result.priceKey).toBe("pro_yearly_v1");
    await billing.deliverWebhooks();
    expect((await billing.store.getSubscription(account.id))?.priceKey).toBe("pro_yearly_v1");
    expect((await billing.provider.fetchCustomerState(customer)).subscription?.usagePriceKey).toBe("ai_usage_yearly_v1");
  });

  it("keeps a founder on the founder price of the other interval", async () => {
    const billing = createTestBilling();
    const { account } = await paidProAccount(billing, "founder", "pro_yearly_founder_v1");
    const result = await billing.payments.switchPlanInterval({ accountId: account.id, interval: "month", requestId: "s1" });
    expect(result.priceKey).toBe("pro_monthly_founder_v1");
  });

  it("does nothing when the interval is already the same", async () => {
    const billing = createTestBilling();
    const { account } = await paidProAccount(billing);
    expect((await billing.payments.switchPlanInterval({ accountId: account.id, interval: "month", requestId: "s1" })).priceKey).toBe("pro_monthly_v1");
  });

  it("refuses an account without a subscription", async () => {
    const billing = createTestBilling();
    const account = await billing.accounts.accountForOwner("user", "free_user");
    await expect(billing.payments.switchPlanInterval({ accountId: account.id, interval: "year", requestId: "s1" })).rejects.toThrow(/no active subscription/);
  });
});
