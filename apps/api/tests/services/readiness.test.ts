import { describe, expect, test, vi } from "vitest";
import {
  createReadinessProbe,
  runReadinessChecks,
  type ReadinessCheck,
} from "../../src/services/readiness";

const ok = (name: string): ReadinessCheck => ({ name, run: async () => "fine" });

describe("runReadinessChecks", () => {
  test("is ok when every check passes", async () => {
    await expect(runReadinessChecks([ok("database"), ok("cache")])).resolves.toEqual({
      ok: true,
      checks: { database: "ok", cache: "ok" },
    });
  });

  test("names a failed check without its error message", async () => {
    const report = await runReadinessChecks([
      ok("database"),
      { name: "cache", run: async () => Promise.reject(new Error("redis://secret-host refused")) },
    ]);

    expect(report).toEqual({ ok: false, checks: { database: "ok", cache: "failed" } });
    expect(JSON.stringify(report)).not.toContain("secret-host");
  });

  test("marks a slow check as timeout", async () => {
    vi.useFakeTimers();
    try {
      const pending = runReadinessChecks(
        [ok("database"), { name: "cache", run: () => new Promise(() => {}) }],
        50,
      );
      await vi.advanceTimersByTimeAsync(50);
      await expect(pending).resolves.toEqual({
        ok: false,
        checks: { database: "ok", cache: "timeout" },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createReadinessProbe", () => {
  test("reuses one report inside the window and runs new checks after it", async () => {
    let now = 1_000;
    const run = vi.fn(async () => "fine");
    const makeChecks = vi.fn((env: { id: number }) => [{ name: `db-${env.id}`, run }]);
    const probe = createReadinessProbe(makeChecks, { reuseMs: 10_000, now: () => now });

    const first = await probe({ id: 1 });
    now += 9_999;
    const reused = await probe({ id: 2 });
    now += 1;
    const fresh = await probe({ id: 3 });

    expect(reused).toBe(first);
    expect(fresh.checks).toEqual({ "db-3": "ok" });
    expect(makeChecks).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("shares the report that is being made with concurrent callers", async () => {
    const run = vi.fn(async () => "fine");
    const probe = createReadinessProbe(() => [{ name: "database", run }], { now: () => 0 });

    await Promise.all([probe(undefined), probe(undefined), probe(undefined)]);

    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("runReadinessChecks with a check that throws at once", () => {
  test("counts it as failed", async () => {
    const report = await runReadinessChecks([
      {
        name: "database",
        run: () => {
          throw new Error("no connection string");
        },
      },
    ]);

    expect(report).toEqual({ ok: false, checks: { database: "failed" } });
  });
});
