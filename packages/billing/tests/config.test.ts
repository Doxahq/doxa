import { describe, expect, it } from "vitest";

import { BillingConfigurationError, DOXA_CATALOG, readBillingConfig } from "../src/index";
import { BILLING_PROVIDERS, createBillingProvider } from "../src/payments/index";
import { FakeClock } from "../src/testing";

const dashboardUrl = "https://doxa.so";

describe("readBillingConfig", () => {
  it("defaults to the none provider, enforcement off and the self_hosted plan", () => {
    expect(readBillingConfig({}, { dashboardUrl })).toEqual({
      provider: "none",
      enforcement: "off",
      defaultPlan: "self_hosted",
      returnBaseUrl: "https://doxa.so",
      stripe: null,
    });
  });

  it("defaults to free with a provider", () => {
    expect(readBillingConfig({ BILLING_PROVIDER: "memory", BILLING_ENFORCEMENT: "shadow" }, { dashboardUrl })).toMatchObject({ defaultPlan: "free", enforcement: "shadow" });
  });

  it("reads the Stripe settings", () => {
    const config = readBillingConfig(
      { BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: "rk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_MANAGED_PAYMENTS: "on", BILLING_RETURN_BASE_URL: "https://app.doxa.so/" },
      { dashboardUrl },
    );
    expect(config).toMatchObject({ provider: "stripe", returnBaseUrl: "https://app.doxa.so", stripe: { managedPayments: true } });
  });

  it.each([
    [{ BILLING_PROVIDER: "paypal" }, /BILLING_PROVIDER "paypal" is not known/],
    [{ BILLING_ENFORCEMENT: "strict" }, /BILLING_ENFORCEMENT/],
    [{ BILLING_DEFAULT_PLAN: "gold" }, /BILLING_DEFAULT_PLAN/],
    [{ BILLING_PROVIDER: "stripe" }, /STRIPE_SECRET_KEY/],
    [{ BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: "pk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_x" }, /secret or restricted key/],
    [{ BILLING_RETURN_BASE_URL: "https://doxa.so/evil?next=x" }, /must be an http\(s\) origin/],
  ])("fails startup on %j", (env, message) => {
    expect(() => readBillingConfig(env, { dashboardUrl })).toThrow(BillingConfigurationError);
    expect(() => readBillingConfig(env, { dashboardUrl })).toThrow(message);
  });

  it("needs a return URL", () => {
    expect(() => readBillingConfig({})).toThrow(/BILLING_RETURN_BASE_URL/);
  });
});

describe("provider registry", () => {
  const deps = { catalog: DOXA_CATALOG, clock: new FakeClock() };

  it("builds the none and memory providers", () => {
    expect(Object.keys(BILLING_PROVIDERS).sort()).toEqual(["memory", "none", "stripe"]);
    expect(createBillingProvider(readBillingConfig({}, { dashboardUrl }), deps).name).toBe("none");
    expect(createBillingProvider(readBillingConfig({ BILLING_PROVIDER: "memory" }, { dashboardUrl }), deps).name).toBe("memory");
  });

  it("builds the Stripe provider when it is configured", () => {
    const config = readBillingConfig({ BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: "rk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" }, { dashboardUrl });
    expect(createBillingProvider(config, deps).name).toBe("stripe");
  });
});
