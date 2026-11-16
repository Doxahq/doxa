import { describe, expect, it } from "vitest";

import { BillingNotConfiguredError, DOXA_CATALOG } from "../src/index";
import { NoneBillingProvider } from "../src/payments/index";
import { describeBillingProviderContract, memoryProviderHarness } from "../src/testing";

describeBillingProviderContract("memory", () => memoryProviderHarness());

describe("none provider", () => {
  const provider = new NoneBillingProvider();

  it("has no capabilities and refuses money operations with billing_not_configured", async () => {
    expect(Object.values(provider.capabilities).every((value) => value === false)).toBe(true);
    await expect(provider.createCheckout()).rejects.toBeInstanceOf(BillingNotConfiguredError);
    await expect(provider.createPortalSession()).rejects.toMatchObject({ code: "billing_not_configured" });
    expect(await provider.listInvoices()).toEqual({ items: [], nextCursor: null });
    expect((await provider.planCatalogSync(DOXA_CATALOG)).actions).toEqual([]);
  });
});
