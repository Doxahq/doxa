import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", async () => (await import("./fixtures")).cloudflareWorkersMock());

import { DocsWarmControl } from "../../src/warm/docs-warm-control";
import { readWarmConfig } from "../../src/warm/warm-config";
import {
  DENIAL_LOG_SAMPLE,
  EMPTY_SLOT_STATE,
  SLOT_LEASE_MS,
  acquireSlot,
  freeSlots,
  releaseSlot,
  type SlotRequest,
} from "../../src/warm/warm-slots";
import { sweepSiteCap } from "../../src/warm/warm-sweep";
import { MemoryStorage, objectState } from "./fixtures";

/** A request of one site whose own cap never binds, unless given. */
function slot(holder: string, max: number, now: number, siteId = "site-1", maxPerSite = 500): SlotRequest {
  return { holder, siteId, max, maxPerSite, now };
}

function controlRequest(holder: string, siteId = "site-1") {
  return { holder, siteId, max: 24, maxPerSite: 500 };
}

describe("warm slots (F9)", () => {
  test("grants up to max holders and renews a held lease", () => {
    let state = EMPTY_SLOT_STATE;
    for (const holder of ["a", "b"]) {
      const decision = acquireSlot(state, slot(holder, 2, 0));
      expect(decision.granted).toBe(true);
      state = decision.state;
    }
    expect(acquireSlot(state, slot("c", 2, 1)).granted).toBe(false);
    const renewed = acquireSlot(state, slot("a", 2, 1_000));
    expect(renewed.granted).toBe(true);
    expect(renewed.state.leases.a).toEqual({ until: 1_000 + SLOT_LEASE_MS, siteId: "site-1" });
    expect(freeSlots(renewed.state, 2, 1_000)).toBe(0);
    expect(freeSlots(releaseSlot(renewed.state, "a", 1_000), 2, 1_000)).toBe(1);
  });

  test("an expired lease frees its slot for another holder", () => {
    const held = acquireSlot(EMPTY_SLOT_STATE, slot("crashed", 1, 0)).state;
    expect(acquireSlot(held, slot("next", 1, SLOT_LEASE_MS - 1)).granted).toBe(false);
    const takeover = acquireSlot(held, slot("next", 1, SLOT_LEASE_MS));
    expect(takeover).toMatchObject({ granted: true, expired: 1, active: 1 });
    expect(Object.keys(takeover.state.leases)).toEqual(["next"]);
  });

  test("never grants more than max over a long random sequence", () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    let state = EMPTY_SLOT_STATE;
    let now = 0;
    for (let step = 0; step < 5_000; step += 1) {
      now += Math.floor(random() * 60_000);
      const index = Math.floor(random() * 60);
      const holder = `w${index}`;
      state =
        random() < 0.6
          ? acquireSlot(state, slot(holder, 24, now, `site-${index % 5}`, 4)).state
          : releaseSlot(state, holder, now);
      const live = Object.values(state.leases).filter((lease) => lease.until > now);
      expect(live.length).toBeLessThanOrEqual(24);
      for (let site = 0; site < 5; site += 1) {
        expect(live.filter((lease) => lease.siteId === `site-${site}`).length).toBeLessThanOrEqual(4);
      }
    }
  });

  test("the control object never exceeds the cap under concurrent calls", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const storage = new MemoryStorage();
    const control = new DocsWarmControl(objectState(storage) as never, {} as never);
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => control.acquireSlot(controlRequest(`w${i}`))),
    );
    expect(results.filter(Boolean)).toHaveLength(24);
    expect(await control.freeSlots({ max: 24 })).toBe(0);
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => control.releaseSlot({ holder: `w${i}` })),
    );
    expect(await control.freeSlots({ max: 24 })).toBe(5);
    // A new instance (after eviction) reads the stored leases.
    const reloaded = new DocsWarmControl(objectState(storage) as never, {} as never);
    expect(await reloaded.freeSlots({ max: 24 })).toBe(5);
  });

  test("a denial that frees no ended lease writes nothing (F2)", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const storage = new MemoryStorage();
    const control = new DocsWarmControl(objectState(storage) as never, {} as never);
    expect(await control.acquireSlot({ holder: "a", siteId: "site-1", max: 1, maxPerSite: 1 })).toBe(true);
    const put = vi.spyOn(storage, "put");
    expect(await control.acquireSlot({ holder: "b", siteId: "site-2", max: 1, maxPerSite: 1 })).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });

  test("a release of a slot that is not held writes nothing (R4)", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const storage = new MemoryStorage();
    const control = new DocsWarmControl(objectState(storage) as never, {} as never);
    expect(await control.acquireSlot({ holder: "a", siteId: "site-1", max: 2, maxPerSite: 2 })).toBe(true);
    const put = vi.spyOn(storage, "put");
    await control.releaseSlot({ holder: "b" });
    expect(put).not.toHaveBeenCalled();
    await control.releaseSlot({ holder: "a" });
    expect(put).toHaveBeenCalledTimes(1);
    expect(await control.freeSlots({ max: 2 })).toBe(2);
  });

  test("a release still drops an ended lease of another holder (R4)", () => {
    const held = acquireSlot(EMPTY_SLOT_STATE, { holder: "a", siteId: "site-1", max: 2, maxPerSite: 2, now: 0 });
    expect(releaseSlot(held.state, "b", 0)).toBe(held.state);
    const later = releaseSlot(held.state, "b", 24 * 60 * 60_000);
    expect(later).not.toBe(held.state);
    expect(later.leases).toEqual({});
  });

  test("the control object validates its input", async () => {
    const control = new DocsWarmControl(objectState(new MemoryStorage()) as never, {} as never);
    await expect(control.acquireSlot(controlRequest(""))).rejects.toThrow();
    await expect(control.acquireSlot({ ...controlRequest("w"), max: 0 })).rejects.toThrow();
    await expect(control.acquireSlot({ ...controlRequest("w"), maxPerSite: 0 })).rejects.toThrow();
    await expect(control.acquireSlot({ holder: "w", max: 24, maxPerSite: 4 })).rejects.toThrow();
  });

  test("FS-L1: one site holds at most its own cap; other sites still get slots", () => {
    let state = EMPTY_SLOT_STATE;
    const results = Array.from({ length: 6 }, (_, i) => {
      const decision = acquireSlot(state, slot(`a${i}`, 24, 0, "site-a", 4));
      state = decision.state;
      return decision;
    });
    expect(results.map((result) => result.granted)).toEqual([true, true, true, true, false, false]);
    expect(results[4]?.denied).toBe("site_cap");
    // A held lease renews even at the site's cap.
    expect(acquireSlot(state, slot("a0", 24, 1, "site-a", 4)).granted).toBe(true);
    expect(acquireSlot(state, slot("b0", 24, 1, "site-b", 4)).granted).toBe(true);
    expect(acquireSlot(state, slot("b0", 4, 1, "site-b", 4)).denied).toBe("global_cap");
    // A released lease frees a slot of that site.
    state = releaseSlot(state, "a1", 2);
    expect(acquireSlot(state, slot("a9", 24, 3, "site-a", 4)).granted).toBe(true);
  });

  test("FC-L10: logs every grant and release, and one denial in 20 with the count", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const control = new DocsWarmControl(objectState(new MemoryStorage()) as never, {} as never);
    for (let i = 0; i < 24 + 2 * DENIAL_LOG_SAMPLE + 1; i += 1) {
      await control.acquireSlot(controlRequest(`w${i}`));
    }
    await control.releaseSlot({ holder: "w0" });
    const lines = info.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(lines.filter((line) => line.granted === true)).toHaveLength(24);
    const denials = lines.filter((line) => line.granted === false);
    expect(denials.map((line) => line.denials)).toEqual([1, 21, 41]);
    expect(denials[0]).toMatchObject({ reason: "global_cap", siteId: "site-1" });
    expect(lines.filter((line) => line.action === "release")).toEqual([
      { event: "docs_warm_slots", action: "release", holder: "w0", active: 23 },
    ]);
  });

  test("FC-H2: a sweep tick never starts more warmers than free slots", () => {
    expect(sweepSiteCap({ sitesPerTick: 200, freeSlots: 24, pools: 8 })).toBe(3);
    expect(sweepSiteCap({ sitesPerTick: 2, freeSlots: 24, pools: 8 })).toBe(2);
    expect(sweepSiteCap({ sitesPerTick: 200, freeSlots: 7, pools: 8 })).toBe(0);
    expect(sweepSiteCap({ sitesPerTick: 200, freeSlots: 5, pools: 1 })).toBe(5);
    for (let free = 0; free <= 30; free += 1) {
      expect(sweepSiteCap({ sitesPerTick: 200, freeSlots: free, pools: 8 }) * 8).toBeLessThanOrEqual(free);
    }
  });
});

describe("warm config", () => {
  test("defaults are off and safe", () => {
    const config = readWarmConfig({});
    expect(config).toMatchObject({
      deploySweep: false,
      maxActiveWarmers: 24,
      maxActiveWarmersPerSite: 4,
      sweepSitesPerTick: 200,
      maxPages: 500,
      maxHostnames: 3,
      siteFillsPerHour: 20_000,
    });
    expect(config.rollout.mode).toBe("off");
    expect(config.pools[0]).toBe("us-east");
  });

  test("an invalid value falls back with a warning", () => {
    const warn = vi.fn();
    const config = readWarmConfig(
      {
        DOXA_PROD_WARM_MODE: "on",
        DOXA_PROD_WARM_DEPLOY_SWEEP: "yes",
        DOXA_WARM_MAX_ACTIVE_WARMERS: "-1",
        DOXA_WARM_MAX_ACTIVE_WARMERS_PER_SITE: "0",
        DOXA_WARM_MAX_PAGES: "lots",
        DOXA_WARM_POOLS: "eu-west,mars,eu-west",
      },
      warn,
    );
    expect(config.rollout.mode).toBe("off");
    expect(config.deploySweep).toBe(false);
    expect(config.maxActiveWarmers).toBe(24);
    expect(config.maxActiveWarmersPerSite).toBe(4);
    expect(config.maxPages).toBe(500);
    expect(config.pools).toEqual(["eu-west"]);
    expect(warn).toHaveBeenCalledTimes(6);
  });

  test("reads valid values", () => {
    const config = readWarmConfig({
      DOXA_PROD_WARM_MODE: "allowlist",
      DOXA_PROD_WARM_SITE_IDS: "site-1, site-2",
      DOXA_PROD_WARM_DEPLOY_SWEEP: "on",
      DOXA_WARM_MAX_HOSTNAMES: "2",
      DOXA_WARM_MAX_ACTIVE_WARMERS_PER_SITE: "8",
      DOXA_WARM_POOLS: "oceania,us-east",
    });
    expect(config.rollout).toEqual({ mode: "allowlist", siteIds: new Set(["site-1", "site-2"]) });
    expect(config.deploySweep).toBe(true);
    expect(config.maxHostnames).toBe(2);
    expect(config.maxActiveWarmersPerSite).toBe(8);
    expect(config.pools).toEqual(["oceania", "us-east"]);
  });
});
