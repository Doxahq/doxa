import { describe, expect, it } from "vitest";

import { IMMUTABLE_PRICE_MESSAGE } from "../../src/catalog/lock";
import { ProviderRejectedError } from "../../src/provider/errors";
import { runCatalogSyncCommand } from "../../src/providers/stripe/sync/command";
import { FakeClock } from "../../src/testing";
import { FakeStripe } from "./fake-stripe";
import { priceId, stripeKit, syncCatalog } from "./helpers";

const creates = (fake: FakeStripe) =>
  fake.requests.filter((request) => request.method === "POST" && /^\/v1\/(products|prices|billing\/meters|billing_portal\/configurations)$/.test(request.path)).length;

describe("stripe catalog sync (spec 7.3)", () => {
  it("plans every product, the meter, every price and both Portal configurations on an empty account", async () => {
    const kit = stripeKit();
    const plan = await kit.provider.planCatalogSync(kit.catalog);
    expect(plan.provider).toBe("stripe");
    expect(plan.actions.map((action) => `${action.kind}:${action.key}`).sort()).toEqual(
      [
        "create_product:doxa_pro",
        "create_product:doxa_ai_usage",
        "create_meter:doxa_ai_overage",
        ...Object.keys(kit.catalog.prices).map((key) => `create_price:${key}`),
        ...Object.keys(kit.catalog.usagePrices).map((key) => `create_price:${key}`),
        "update_portal:founder",
        "update_portal:standard",
      ].sort(),
    );
    expect(plan.actions.some((action) => action.kind === "keep_price")).toBe(false);
    expect(kit.fake.requests.every((request) => request.method === "GET")).toBe(true); // a plan never writes
  });

  it("applies with tax codes, lookup keys, a metered usage price and idempotency keys; the plan is then empty", async () => {
    const kit = stripeKit();
    const result = await kit.provider.applyCatalogSync(await kit.provider.planCatalogSync(kit.catalog));
    expect(result.applied).toBe(2 + 1 + 8 + 2);
    expect(kit.fake.products.get("doxa_pro")).toMatchObject({ tax_code: "txcd_10103001", metadata: { doxa_plan: "pro" } });
    expect(kit.fake.products.get("doxa_ai_usage")).toMatchObject({ tax_code: "txcd_10105002" });
    const meter = [...kit.fake.meters.values()][0];
    expect(meter).toMatchObject({ event_name: "doxa_ai_overage", default_aggregation: { formula: "sum" }, customer_mapping: { event_payload_key: "stripe_customer_id" }, value_settings: { event_payload_key: "value" } });
    const usage = [...kit.fake.prices.values()].find((row) => row.lookup_key === "ai_usage_yearly_v1");
    expect(usage).toMatchObject({ product: "doxa_ai_usage", unit_amount: 1, recurring: { interval: "year", usage_type: "metered", meter: meter?.id } });
    expect([...kit.fake.prices.values()].find((row) => row.lookup_key === "pro_yearly_founder_v1")).toMatchObject({ unit_amount: 154_800, product: "doxa_pro", recurring: { interval: "year", usage_type: "licensed" } });
    expect([...kit.fake.prices.values()].find((row) => row.lookup_key === "pro_yearly_founder_v2")).toMatchObject({ unit_amount: 118_800, product: "doxa_pro", recurring: { interval: "year", usage_type: "licensed" } });
    for (const request of kit.fake.requests.filter((row) => row.method === "POST" && /^\/v1\/(products|prices|billing\/meters)$/.test(row.path))) {
      expect(request.headers["idempotency-key"]).toMatch(/^doxa-catalog-sync:/);
    }
    const portals = [...kit.fake.portalConfigurations.values()];
    const founder = portals.find((row) => (row.metadata as Record<string, string>).doxa_portal === "founder");
    const standard = portals.find((row) => (row.metadata as Record<string, string>).doxa_portal === "standard");
    // spec 13: the Portal cannot update a subscription with a usage price, so
    // both configurations turn plan updates off; the API switches the interval.
    expect((founder?.features as { subscription_update: { enabled: unknown } }).subscription_update.enabled).toBe("false");
    expect((standard?.features as { subscription_update: { enabled: unknown } }).subscription_update.enabled).toBe("false");
    expect((founder?.features as { subscription_cancel: unknown }).subscription_cancel).toMatchObject({ enabled: "true", mode: "at_period_end" });

    const before = creates(kit.fake);
    expect((await kit.provider.planCatalogSync(kit.catalog)).actions).toEqual([]);
    expect(await kit.provider.applyCatalogSync(await kit.provider.planCatalogSync(kit.catalog))).toEqual({ applied: 0 });
    expect(creates(kit.fake)).toBe(before);
  });

  it("keeps a stale plan safe: applying the first plan twice creates nothing new", async () => {
    const kit = stripeKit();
    const plan = await kit.provider.planCatalogSync(kit.catalog);
    await kit.provider.applyCatalogSync(plan);
    const before = creates(kit.fake);
    expect(await kit.provider.applyCatalogSync(plan)).toEqual({ applied: 0 });
    expect(creates(kit.fake)).toBe(before);
  });

  it("stops when Stripe holds a price with another amount: prices are immutable", async () => {
    const kit = stripeKit();
    await syncCatalog(kit);
    const price = [...kit.fake.prices.values()].find((row) => row.lookup_key === "pro_monthly_v1")!;
    price.unit_amount = 19_900;
    const error = await kit.provider.planCatalogSync(kit.catalog).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderRejectedError);
    expect((error as Error).message).toContain(IMMUTABLE_PRICE_MESSAGE);
    expect(kit.fake.requests.filter((request) => request.method === "POST" && request.path === `/v1/prices/${price.id}`)).toEqual([]);
  });

  it("archives a Doxa price that left the catalog only when no live subscription uses it", async () => {
    const kit = stripeKit();
    await syncCatalog(kit);
    const old = await kit.provider.client.prices.create({
      product: "doxa_pro",
      currency: "usd",
      unit_amount: 9_900,
      lookup_key: "pro_monthly_v0",
      recurring: { interval: "month" },
      metadata: { doxa_managed: "true", doxa_price_key: "pro_monthly_v0" },
    });
    kit.fake.subscriptions.set("sub_fake9000", {
      id: "sub_fake9000",
      object: "subscription",
      customer: "cus_x",
      status: "active",
      items: { object: "list", data: [{ id: "si_x", price: kit.fake.prices.get(old.id) }] },
    });
    const kept = await kit.provider.planCatalogSyncDetailed(kit.catalog);
    expect(kept.actions).toEqual([]);
    expect(kept.keeps.map((line) => line.description).join("\n")).toContain("pro_monthly_v0  (no catalog entry, has live subscriptions)");

    kit.fake.subscriptions.get("sub_fake9000")!.status = "canceled";
    const plan = await kit.provider.planCatalogSync(kit.catalog);
    expect(plan.actions).toEqual([{ kind: "archive_price", key: "pro_monthly_v0", description: expect.stringContaining("archive price") }]);
    await kit.provider.applyCatalogSync(plan);
    expect(kit.fake.prices.get(old.id)?.active).toBe(false);
    expect(kit.fake.prices.has(old.id)).toBe(true); // never deleted
    expect((await kit.provider.planCatalogSync(kit.catalog)).actions).toEqual([]);
  });

  it("restores a drifted product tax code and a changed Portal configuration", async () => {
    const kit = stripeKit();
    await syncCatalog(kit);
    kit.fake.products.get("doxa_ai_usage")!.tax_code = "txcd_10000000";
    const founder = [...kit.fake.portalConfigurations.values()].find((row) => (row.metadata as Record<string, string>).doxa_portal === "founder")!;
    founder.metadata = { ...(founder.metadata as Record<string, string>), doxa_config_hash: "old" };
    const plan = await kit.provider.planCatalogSync(kit.catalog);
    expect(plan.actions.map((action) => `${action.kind}:${action.key}`)).toEqual(["set_tax_code:doxa_ai_usage", "update_portal:founder"]);
    await kit.provider.applyCatalogSync(plan);
    expect(kit.fake.portalConfigurations.size).toBe(2); // updated in place
    expect((await kit.provider.planCatalogSync(kit.catalog)).actions).toEqual([]);
  });
});

describe("catalog sync command", () => {
  const io = (fake: FakeStripe, argv: string[], key = "sk_test_cmd") => {
    const lines: string[] = [];
    return { lines, run: () => runCatalogSyncCommand({ argv, env: { STRIPE_SECRET_KEY: key }, print: (line) => lines.push(line), httpClient: fake.httpClient }) };
  };

  it("prints a dry-run plan by default and changes nothing", async () => {
    const fake = new FakeStripe(new FakeClock());
    const cmd = io(fake, []);
    expect(await cmd.run()).toBe(0);
    expect(cmd.lines[0]).toBe("Stripe account: Doxa Test (sandbox/test)");
    expect(cmd.lines.join("\n")).toContain("Plan (dry run, nothing changed):");
    expect(cmd.lines.join("\n")).toContain("create price    pro_monthly_founder_v1  $159.00 / month");
    expect(fake.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("applies with --apply and checks that the plan is then empty", async () => {
    const fake = new FakeStripe(new FakeClock());
    const cmd = io(fake, ["--apply"]);
    expect(await cmd.run()).toBe(0);
    expect(cmd.lines.at(-1)).toBe("The plan is empty.");
    const again = io(fake, []);
    await again.run();
    expect(again.lines.join("\n")).toContain("keep   price    pro_yearly_v1");
  });

  it("refuses a live key without --live, and --live with a test key", async () => {
    const fake = new FakeStripe(new FakeClock());
    expect(await io(fake, ["--apply"], "sk_live_x").run()).toBe(2);
    expect(await io(fake, ["--live"], "sk_test_x").run()).toBe(2);
    expect(await io(fake, [], "").run()).toBe(2);
    expect(fake.requests).toEqual([]);
  });
});
