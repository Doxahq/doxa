import { describe, expect, it } from "vitest";

import { DAY_MS, DOXA_CATALOG, ExportQuota, HOUR_MS, UsageQuota, exportWindowHours, resolveEntitlements } from "../src/index";
import { FakeClock, MemoryBillingStore, TEST_NOW } from "../src/testing";

const free = resolveEntitlements({ catalog: DOXA_CATALOG, defaultPlan: "free", subscription: null, overrides: [], now: TEST_NOW });
const pro = resolveEntitlements({ catalog: DOXA_CATALOG, defaultPlan: "pro", subscription: null, overrides: [], now: TEST_NOW });

describe("daily quota", () => {
  it("counts and denies above the limit with a reset at 00:00 UTC", async () => {
    const clock = new FakeClock(new Date("2026-11-13T23:59:58.000Z"));
    const store = new MemoryBillingStore();
    const quota = new UsageQuota({ store, clock });
    for (let call = 1; call <= 20; call += 1) {
      const result = await quota.consume("mcp.tool_calls", "acct_1", free);
      expect(result.allowed).toBe(true);
    }
    const over = await quota.consume("mcp.tool_calls", "acct_1", free);
    expect(over).toMatchObject({ allowed: false, count: 21, limit: 20, resetsAt: new Date("2026-11-14T00:00:00.000Z") });
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

  it("lets exactly 20 of 200 parallel calls through", async () => {
    const store = new MemoryBillingStore();
    const quota = new UsageQuota({ store, clock: new FakeClock() });
    const results = await Promise.all(Array.from({ length: 200 }, () => quota.consume("mcp.tool_calls", "acct_1", free)));
    expect(results.filter((result) => result.allowed)).toHaveLength(20);
  });
});

describe("docs export quota", () => {
  const enterprise = resolveEntitlements({ catalog: DOXA_CATALOG, defaultPlan: "enterprise", subscription: null, overrides: [], now: TEST_NOW });
  const selfHosted = resolveEntitlements({ catalog: DOXA_CATALOG, defaultPlan: "self_hosted", subscription: null, overrides: [], now: TEST_NOW });

  it("gives the plans their windows: Free 24 hours, paid 1 hour, self-hosted none", () => {
    expect(exportWindowHours(free)).toBe(24);
    expect(exportWindowHours(pro)).toBe(1);
    expect(exportWindowHours(enterprise)).toBe(1);
    expect(exportWindowHours(selfHosted)).toBe(0);
  });

  it("opens the next Free export 24 hours after the last one, not at 00:00 UTC", async () => {
    const clock = new FakeClock(new Date("2026-11-16T23:59:00.000Z"));
    const quota = new ExportQuota({ store: new MemoryBillingStore(), clock });
    expect(await quota.reserve("acct_1", free)).toMatchObject({ allowed: true, resetsAt: new Date("2026-11-17T23:59:00.000Z") });
    clock.set(new Date("2026-11-17T00:01:00.000Z"));
    const denied = await quota.reserve("acct_1", free);
    expect(denied).toMatchObject({ allowed: false, resetsAt: new Date("2026-11-17T23:59:00.000Z") });
    expect(await quota.status("acct_1", free)).toMatchObject({ available: false, resetsAt: new Date("2026-11-17T23:59:00.000Z") });
    clock.set(new Date("2026-11-17T23:59:00.000Z"));
    expect(await quota.status("acct_1", free)).toMatchObject({ available: true, resetsAt: null });
    expect((await quota.reserve("acct_1", free)).allowed).toBe(true);
  });

  it("opens the next paid export one hour after the last one", async () => {
    const clock = new FakeClock(new Date("2026-11-16T10:59:00.000Z"));
    const quota = new ExportQuota({ store: new MemoryBillingStore(), clock });
    expect((await quota.reserve("acct_1", pro)).allowed).toBe(true);
    clock.advance(2 * 60_000);
    expect(await quota.reserve("acct_1", pro)).toMatchObject({ allowed: false, resetsAt: new Date("2026-11-16T11:59:00.000Z") });
    clock.set(new Date("2026-11-16T11:59:00.000Z"));
    expect((await quota.reserve("acct_1", pro)).allowed).toBe(true);
  });

  it("a denied export does not move the window", async () => {
    const clock = new FakeClock(new Date("2026-11-16T10:00:00.000Z"));
    const quota = new ExportQuota({ store: new MemoryBillingStore(), clock });
    await quota.reserve("acct_1", pro);
    clock.advance(50 * 60_000);
    expect((await quota.reserve("acct_1", pro)).allowed).toBe(false);
    clock.advance(10 * 60_000);
    expect((await quota.reserve("acct_1", pro)).allowed).toBe(true);
  });

  it("uses the window of the current plan: an upgrade opens sooner, a downgrade later", async () => {
    const clock = new FakeClock(new Date("2026-11-16T10:00:00.000Z"));
    const quota = new ExportQuota({ store: new MemoryBillingStore(), clock });
    await quota.reserve("acct_up", free);
    await quota.reserve("acct_down", pro);
    clock.advance(3 * HOUR_MS);
    expect((await quota.reserve("acct_up", pro)).allowed).toBe(true);
    expect(await quota.reserve("acct_down", free)).toMatchObject({ allowed: false, resetsAt: new Date("2026-11-17T10:00:00.000Z") });
  });

  it("counts each billing account apart", async () => {
    const quota = new ExportQuota({ store: new MemoryBillingStore(), clock: new FakeClock() });
    expect((await quota.reserve("acct_1", free)).allowed).toBe(true);
    expect((await quota.reserve("acct_2", free)).allowed).toBe(true);
  });

  it("lets exactly one of 20 parallel exports through", async () => {
    const quota = new ExportQuota({ store: new MemoryBillingStore(), clock: new FakeClock() });
    const results = await Promise.all(Array.from({ length: 20 }, () => quota.reserve("acct_1", free)));
    expect(results.filter((result) => result.allowed)).toHaveLength(1);
  });

  it("a release gives the export back once and restores the export before it", async () => {
    const clock = new FakeClock(new Date("2026-11-16T10:00:00.000Z"));
    const quota = new ExportQuota({ store: new MemoryBillingStore(), clock });
    await quota.reserve("acct_1", pro);
    clock.advance(2 * HOUR_MS);
    const second = await quota.reserve("acct_1", pro);
    if (!second.allowed) throw new Error("denied");
    await second.release();
    await second.release();
    expect(await quota.status("acct_1", pro)).toMatchObject({ available: true, lastExportAt: new Date("2026-11-16T10:00:00.000Z") });
    // The restored export is 2 hours old: on Free it still blocks.
    expect(await quota.status("acct_1", free)).toMatchObject({ available: false, resetsAt: new Date("2026-11-17T10:00:00.000Z") });
  });

  it("writes nothing for a plan without a quota", async () => {
    const store = new MemoryBillingStore();
    const quota = new ExportQuota({ store, clock: new FakeClock() });
    for (let call = 0; call < 3; call += 1) expect(await quota.reserve("acct_1", selfHosted)).toMatchObject({ allowed: true, unlimited: true });
    expect(await store.readLastExport("acct_1")).toBeNull();
  });

  it("uses the strictest window for a broken limit and no quota for UNLIMITED", () => {
    expect(exportWindowHours({ ...free, limits: { ...free.limits, "docs.export_window_hours": -1 } })).toBe(24);
    expect(exportWindowHours({ ...free, limits: { ...free.limits, "docs.export_window_hours": 1.5 } })).toBe(24);
    expect(exportWindowHours({ ...free, limits: { ...free.limits, "docs.export_window_hours": "unlimited" } })).toBe(0);
  });
});
