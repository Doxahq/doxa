import { describe, expect, test, vi } from "vitest";
import { AnalyticsOptOutCache, cachedOptOutCheck } from "../../../src/services/analytics/opt-out-cache";
import { InMemoryPrivacySettings } from "../../support/in-memory-privacy-settings";

function clock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

describe("AnalyticsOptOutCache", () => {
  test("reads the settings once, then answers from memory until the entry expires", async () => {
    const time = clock();
    const cache = new AnalyticsOptOutCache({ ttlMs: 1_000, now: time.now });
    const load = vi.fn(async () => true);

    expect(await cache.read("user-1", load)).toBe(true);
    expect(await cache.read("user-1", load)).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);

    time.advance(1_000);
    expect(await cache.read("user-1", load)).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("starts the load before it returns, so a closing request's database still serves it", () => {
    const cache = new AnalyticsOptOutCache();
    const load = vi.fn(async () => false);

    void cache.read("user-1", load);

    expect(load).toHaveBeenCalledTimes(1);
  });

  test("two reads of one person share one load", async () => {
    const cache = new AnalyticsOptOutCache();
    const load = vi.fn(async () => false);

    const answers = await Promise.all([cache.read("user-1", load), cache.read("user-1", load)]);

    expect(answers).toEqual([false, false]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test("a change in this process wins over a load that read the old value", async () => {
    const cache = new AnalyticsOptOutCache();
    let finish: (optedOut: boolean) => void = () => {};
    const slowLoad = () => new Promise<boolean>((resolve) => (finish = resolve));

    const stale = cache.read("user-1", slowLoad);
    cache.remember("user-1", true);
    finish(false);

    expect(await stale).toBe(false);
    expect(await cache.read("user-1", async () => false)).toBe(true);
  });

  test("a failed load is not kept", async () => {
    const cache = new AnalyticsOptOutCache();

    await expect(cache.read("user-1", async () => Promise.reject(new Error("database down")))).rejects.toThrow("database down");
    await expect(
      cache.read("user-1", () => {
        throw new Error("scope closed");
      }),
    ).rejects.toThrow("scope closed");
    expect(await cache.read("user-1", async () => true)).toBe(true);
  });

  test("keeps at most maxEntries people and drops the oldest", async () => {
    const cache = new AnalyticsOptOutCache({ maxEntries: 2 });
    for (const userId of ["user-1", "user-2", "user-3"]) cache.remember(userId, true);

    expect(cache.size).toBe(2);
    const load = vi.fn(async () => false);
    expect(await cache.read("user-3", load)).toBe(true);
    expect(await cache.read("user-1", load)).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("cachedOptOutCheck", () => {
  test("a person without a row is opted in; a stored switch-off opts them out", async () => {
    const store = new InMemoryPrivacySettings();
    await store.setProductAnalytics("user-2", false, new Date());
    const check = cachedOptOutCheck(new AnalyticsOptOutCache(), () => store);

    expect(await check("user-1")).toBe(false);
    expect(await check("user-2")).toBe(true);
    expect(await check("user-2")).toBe(true);
    expect(store.reads).toBe(2);
  });
});
