import { PlanLimitError, type BillingEnforcement } from "@doxahq/billing";
import { subscriptionFixture } from "@doxahq/billing/testing";
import { describe, expect, test } from "vitest";
import type { BillingDenial } from "../../../src/services/billing/enforcement";
import { createMcpBilling } from "../../../src/services/billing/mcp-billing";
import { createBillingHarness } from "../../support/billing-harness";

const OWNER = "user-1";
const PROJECT = "project-a";
const TEAM = "team-1";

function setup(mode: BillingEnforcement) {
  const harness = createBillingHarness({ enforcement: mode });
  harness.billing.projects.set(PROJECT, { userId: OWNER });
  const denials: BillingDenial[] = [];
  let builds = 0;
  const billing = createMcpBilling({
    mode,
    core: () => {
      builds += 1;
      return harness.core;
    },
    log: (denial) => denials.push(denial),
  });
  return { harness, billing, denials, builds: () => builds };
}

describe("MCP daily tool-call quota (billing spec 11)", () => {
  test("off counts nothing, builds no billing, and get_account gets no billing field", async () => {
    const { billing, builds, harness } = setup("off");
    for (let call = 0; call < 150; call += 1) await billing.consumeToolCall(PROJECT);
    await expect(billing.accountsFor(OWNER, [])).resolves.toBeNull();
    expect(builds()).toBe(0);
    // No account row and no allowance grant was written.
    expect(await harness.core.store.findAccountByOwner("user", OWNER)).toBeNull();
  });

  test("on: Free allows 20 calls a day, then plan_limit with the reset at 00:00 UTC", async () => {
    const { billing, denials, harness } = setup("on");
    for (let call = 0; call < 20; call += 1) await billing.consumeToolCall(PROJECT);
    const refused = await billing.consumeToolCall(PROJECT).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PlanLimitError);
    expect((refused as PlanLimitError).details).toMatchObject({ key: "mcp.tool_calls_per_day", limit: 20, used: 21 });
    expect((refused as PlanLimitError).details.resetsAt?.toISOString()).toBe("2026-11-14T00:00:00.000Z");
    expect(denials).toEqual([expect.objectContaining({ key: "mcp.tool_calls_per_day", mode: "on", kind: "denied", plan: "free" })]);
    harness.billing.clock.set(new Date("2026-11-14T00:00:01.000Z"));
    await expect(billing.consumeToolCall(PROJECT)).resolves.toBeUndefined();
  });

  test("shadow counts and logs, and never refuses", async () => {
    const { billing, denials } = setup("shadow");
    for (let call = 0; call < 21; call += 1) await billing.consumeToolCall(PROJECT);
    expect(denials).toEqual([expect.objectContaining({ mode: "shadow", used: 21 })]);
  });

  test("an unlimited plan skips the counter", async () => {
    const { billing, harness } = setup("on");
    const account = await harness.core.accounts.accountForOwner("user", OWNER);
    await harness.billing.setSubscription(subscriptionFixture({ accountId: account.id }));
    for (let call = 0; call < 150; call += 1) await billing.consumeToolCall(PROJECT);
    await expect(harness.core.quota.read("mcp.tool_calls", account.id)).resolves.toBe(0);
  });
});

describe("get_account billing (billing spec 15.3)", () => {
  test("lists the personal account and the team accounts with billing.read", async () => {
    const { billing } = setup("on");
    await billing.consumeToolCall(PROJECT);
    const accounts = await billing.accountsFor(OWNER, [
      { id: TEAM, role: "admin" },
      { id: "team-2", role: "editor" },
    ]);
    expect(accounts).toHaveLength(2);
    expect(accounts?.[0]).toMatchObject({
      ownerKind: "user",
      teamId: null,
      plan: "free",
      credits: { available: 0 },
      payg: { active: false, debt: 0 },
      toolCalls: { today: 1, limit: 20, resetsAt: "2026-11-14T00:00:00.000Z" },
    });
    expect(accounts?.[1]).toMatchObject({ ownerKind: "team", teamId: TEAM, plan: "free" });
  });

  test("a billing error gives no accounts", async () => {
    const billing = createMcpBilling({ mode: "on", core: () => { throw new Error("down"); }, log: () => undefined });
    await expect(billing.accountsFor(OWNER, [])).resolves.toEqual([]);
    await expect(billing.consumeToolCall(PROJECT)).resolves.toBeUndefined();
  });
});
