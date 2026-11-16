import { describe, expect, test, vi } from "vitest";
import { DOXA_CATALOG, HOUR_MS, resolveEntitlements, type BillingEnforcement } from "@doxahq/billing";
import { FakeClock, MemoryBillingStore } from "@doxahq/billing/testing";
import { ExportBillingUnavailableError, createExportBilling } from "../../../src/services/billing/export-billing";

const NOW = new Date("2026-11-16T10:30:00.000Z");
const plan = (key: "free" | "pro" | "enterprise" | "self_hosted") =>
  resolveEntitlements({ catalog: DOXA_CATALOG, defaultPlan: key, subscription: null, overrides: [], now: NOW });

function setup(mode: BillingEnforcement, accounts: Record<string, { id: string; plan: "free" | "pro" | "enterprise" | "self_hosted" }>) {
  const store = new MemoryBillingStore();
  const clock = new FakeClock(NOW);
  const forProject = vi.fn(async (projectId: string) => {
    const account = accounts[projectId];
    if (!account) throw new Error("no account");
    return { account: { id: account.id }, entitlements: plan(account.plan) };
  });
  const log = vi.fn();
  const core = vi.fn(() => ({ store, clock, entitlements: { forProject } }) as never);
  const billing = createExportBilling({ mode, core, log });
  return { billing, clock, forProject, log, core, store };
}

describe("export billing", () => {
  test("Free: one export every 24 hours, counted from the last export", async () => {
    const { billing, clock } = setup("on", { p1: { id: "acct-free", plan: "free" } });
    const first = await billing.reserve("p1");
    expect(first).toMatchObject({ allowed: true, quota: { plan: "free", windowHours: 24 } });
    clock.set(new Date("2026-11-17T00:00:01.000Z"));
    const second = await billing.reserve("p1");
    expect(second).toMatchObject({ allowed: false, quota: { resetsAt: "2026-11-17T10:30:00.000Z" } });
    expect(await billing.status("p1")).toMatchObject({ available: false, windowHours: 24, resetsAt: "2026-11-17T10:30:00.000Z" });
    clock.set(new Date("2026-11-17T10:30:00.000Z"));
    expect(await billing.status("p1")).toMatchObject({ available: true, resetsAt: null });
    expect((await billing.reserve("p1")).allowed).toBe(true);
  });

  test("Pro and Enterprise: one export an hour after the last one", async () => {
    for (const key of ["pro", "enterprise"] as const) {
      const { billing, clock } = setup("on", { p1: { id: `acct-${key}`, plan: key } });
      expect((await billing.reserve("p1")).allowed).toBe(true);
      expect(await billing.reserve("p1")).toMatchObject({ allowed: false, quota: { windowHours: 1, resetsAt: "2026-11-16T11:30:00.000Z" } });
      clock.advance(HOUR_MS);
      expect((await billing.reserve("p1")).allowed).toBe(true);
    }
  });

  test("two projects of one account share its quota", async () => {
    const { billing } = setup("on", { p1: { id: "acct-1", plan: "free" }, p2: { id: "acct-1", plan: "free" } });
    expect((await billing.reserve("p1")).allowed).toBe(true);
    expect((await billing.reserve("p2")).allowed).toBe(false);
  });

  test("a released export frees the window", async () => {
    const { billing } = setup("on", { p1: { id: "acct-1", plan: "free" } });
    const first = await billing.reserve("p1");
    if (!first.allowed) throw new Error("denied");
    await first.release();
    expect((await billing.reserve("p1")).allowed).toBe(true);
  });

  test("only one of many parallel exports passes", async () => {
    const { billing } = setup("on", { p1: { id: "acct-1", plan: "pro" } });
    const results = await Promise.all(Array.from({ length: 10 }, () => billing.reserve("p1")));
    expect(results.filter((result) => result.allowed)).toHaveLength(1);
  });

  test("self-hosted plan: no quota", async () => {
    const { billing } = setup("on", { p1: { id: "acct-1", plan: "self_hosted" } });
    for (let call = 0; call < 3; call += 1) expect((await billing.reserve("p1")).allowed).toBe(true);
  });

  test("off: no quota and no billing read", async () => {
    const { billing, core } = setup("off", {});
    expect((await billing.reserve("p1")).allowed).toBe(true);
    expect(await billing.status("p1")).toEqual({ available: true, plan: null, windowHours: null, resetsAt: null });
    expect(core).not.toHaveBeenCalled();
  });

  test("shadow: counts and logs a denial, then allows", async () => {
    const { billing, log } = setup("shadow", { p1: { id: "acct-1", plan: "free" } });
    await billing.reserve("p1");
    expect((await billing.reserve("p1")).allowed).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ key: "docs.export_window_hours", kind: "denied", mode: "shadow" }));
  });

  test("a billing failure denies the export", async () => {
    const { billing } = setup("on", {});
    await expect(billing.reserve("missing")).rejects.toBeInstanceOf(ExportBillingUnavailableError);
    await expect(billing.status("missing")).rejects.toBeInstanceOf(ExportBillingUnavailableError);
  });
});
