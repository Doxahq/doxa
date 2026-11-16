import { describe, expect, it } from "vitest";

import { DAY_MS, DOXA_CATALOG, UsageQuota, resolveEntitlements } from "../src/index";
import { FakeClock, MemoryBillingStore, TEST_NOW } from "../src/testing";

const free = resolveEntitlements({ catalog: DOXA_CATALOG, defaultPlan: "free", subscription: null, overrides: [], now: TEST_NOW });
const pro = resolveEntitlements({ catalog: DOXA_CATALOG, defaultPlan: "pro", subscription: null, overrides: [], now: TEST_NOW });

describe("daily quota", () => {
  it("counts and denies above the limit with a reset at 00:00 UTC", async () => {
    const clock = new FakeClock(new Date("2026-11-13T23:59:58.000Z"));
    const store = new MemoryBillingStore();
    const quota = new UsageQuota({ store, clock });
    for (let call = 1; call <= 100; call += 1) {
      const result = await quota.consume("mcp.tool_calls", "acct_1", free);
      expect(result.allowed).toBe(true);
    }
    const over = await quota.consume("mcp.tool_calls", "acct_1", free);
    expect(over).toMatchObject({ allowed: false, count: 101, limit: 100, resetsAt: new Date("2026-11-14T00:00:00.000Z") });
    clock.advance(2_000);
    expect(await quota.consume("mcp.tool_calls", "acct_1", free)).toMatchObject({ allowed: true, count: 1 });
    expect(await quota.read("mcp.tool_calls", "acct_1")).toBe(1);
    expect(await quota.consume("mcp.tool_calls", "acct_2", free)).toMatchObject({ count: 1 });
    clock.advance(DAY_MS);
    expect(await quota.read("mcp.tool_calls", "acct_1")).toBe(0);
  });

  it("skips the write for an unlimited plan", async () => {
    const store = new MemoryBillingStore();
    const quota = new UsageQuota({ store, clock: new FakeClock() });
    expect(await quota.consume("mcp.tool_calls", "acct_1", pro)).toEqual({ allowed: true, unlimited: true });
    expect(await quota.read("mcp.tool_calls", "acct_1")).toBe(0);
  });

  it("lets exactly 100 of 200 parallel calls through", async () => {
    const store = new MemoryBillingStore();
    const quota = new UsageQuota({ store, clock: new FakeClock() });
    const results = await Promise.all(Array.from({ length: 200 }, () => quota.consume("mcp.tool_calls", "acct_1", free)));
    expect(results.filter((result) => result.allowed)).toHaveLength(100);
  });
});
