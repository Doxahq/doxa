import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", async () => (await import("./fixtures")).cloudflareWorkersMock());

import type { PublicCacheCall } from "../../src/public-cache-calls";
import type { FillOutcome } from "../../src/warm/warm-fill";
import type { WarmJob, WarmOutcome, WarmTarget } from "../../src/warm/warm-job";
import type { FillReservation } from "../../src/warm/warm-lock-state";
import {
  MAX_SLOT_WAITS,
  READINESS_MAX_WAIT_MS,
  READINESS_RETRY_MS,
  REFILL_DELAY_MS,
  SLOT_RETRY_MAX_MS,
  SLOT_RETRY_MS,
  slotRetryDelay,
  WARM_ALARM_BUDGET_MS,
  WARM_FILL_CONCURRENCY,
  readWarmerState,
  runWarmerAlarm,
  sampleIndexes,
  startWarmer,
  unitAt,
  unitCount,
  type WarmerDeps,
} from "../../src/warm/warm-warmer";
import { MemoryStorage, OTHER_JOB_ID, siteResolution, warmJob } from "./fixtures";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A fake call: its URL names the hostname, page and representation. */
function fakeCall(target: WarmTarget, pathname: string, representation: string, saved: boolean): PublicCacheCall {
  return {
    entrypoint: saved ? "DocsPrerenderCache" : representation === "html" ? "DocsHtmlCache" : "DocsRouteDataCache",
    props: {} as never,
    request: new Request(`https://${target.hostname}${pathname}#${representation}`),
  };
}

function keyOf(call: PublicCacheCall): string {
  return call.request.url;
}

interface Harness {
  deps: WarmerDeps;
  storage: MemoryStorage;
  clock: { now: number };
  reports: (WarmOutcome | "running")[];
  fills: string[];
  probes: string[];
  stored: Set<string>;
  maxInFlight: () => number;
}

function createHarness(options: {
  job?: WarmJob;
  slots?: boolean;
  superseded?: boolean | (() => boolean);
  saved?: boolean;
  ready?: () => boolean;
  /** Keys that a fill reports filled but the cache does not keep. */
  lost?: Set<string>;
  fillMs?: number;
  budget?: number;
  /** The lock's answer to a heartbeat; true by default. */
  current?: () => boolean;
  /** The job ended at the lock: reservations answer job_ended. */
  ended?: () => boolean;
} = {}): Harness {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  const storage = new MemoryStorage();
  const clock = { now: 100_000 };
  const reports: (WarmOutcome | "running")[] = [];
  const fills: string[] = [];
  const probes: string[] = [];
  const stored = new Set<string>();
  let inFlight = 0;
  let maxInFlight = 0;
  let budget = options.budget ?? Number.POSITIVE_INFINITY;
  const deps: WarmerDeps = {
    storage,
    now: () => clock.now,
    holder: "warmer-1",
    slots: {
      acquire: vi.fn(async (_holder: string, _siteId: string) => options.slots ?? true),
      release: vi.fn(async () => undefined),
    },
    lock: {
      report: vi.fn(async (_job: WarmJob, report: WarmOutcome | "running") => {
        reports.push(report);
      }),
      heartbeat: vi.fn(async () => options.current?.() ?? true),
      reserveFills: vi.fn(async (_job: WarmJob, count: number): Promise<FillReservation> => {
        if (options.ended?.()) return { status: "job_ended" };
        const granted = Math.min(count, budget);
        budget -= granted;
        return granted > 0 || count === 0
          ? { status: "granted", count: granted }
          : { status: "budget_exhausted", retryAt: clock.now + 3_600_000 };
      }),
    },
    isSuperseded: vi.fn(async () =>
      typeof options.superseded === "function" ? options.superseded() : (options.superseded ?? false),
    ),
    selectCalls: vi.fn(async (target: WarmTarget, pathname: string) => ({
      html: fakeCall(target, pathname, "html", options.saved ?? false),
      data: fakeCall(target, pathname, "data", options.saved ?? false),
      saved: options.saved ?? false,
    })),
    isSavedOutputReady: vi.fn(async () => options.ready?.() ?? true),
    fill: vi.fn(async (call: PublicCacheCall): Promise<FillOutcome> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      clock.now += options.fillMs ?? 10;
      inFlight -= 1;
      fills.push(keyOf(call));
      if (!options.lost?.has(keyOf(call))) stored.add(keyOf(call));
      return "filled";
    }),
    probe: vi.fn(async (call: PublicCacheCall) => {
      probes.push(keyOf(call));
      return stored.has(keyOf(call));
    }),
  };
  return { deps, storage, clock, reports, fills, probes, stored, maxInFlight: () => maxInFlight };
}

async function start(harness: Harness, job = warmJob({ startedAt: harness.clock.now })) {
  await startWarmer(harness.storage, job, harness.clock.now);
  return job;
}

describe("regional warmer", () => {
  test("fills every page of every hostname, verifies, reports done and clears", async () => {
    const harness = createHarness();
    const job = await start(harness);
    await runWarmerAlarm(harness.deps);
    expect(harness.fills).toEqual([
      "https://docs.example.com/#html",
      "https://docs.example.com/#data",
      "https://docs.example.com/guide#html",
      "https://docs.example.com/guide#data",
    ]);
    expect(harness.reports).toEqual(["running", "done"]);
    expect(harness.storage.values.size).toBe(0);
    expect(harness.storage.alarm).toBeNull();
    expect(harness.deps.slots.release).toHaveBeenCalledWith("warmer-1");
    expect(unitCount(job)).toBe(4);
  });

  test("waits 30 s for a slot and fills nothing without one", async () => {
    const harness = createHarness({ slots: false });
    await start(harness);
    await runWarmerAlarm(harness.deps);
    expect(harness.fills).toEqual([]);
    expect(harness.storage.alarm).toBe(harness.clock.now + SLOT_RETRY_MS);
    expect(harness.deps.slots.release).not.toHaveBeenCalled();
    expect(await readWarmerState(harness.storage)).not.toBeNull();
  });

  test("stops a superseded job before any fill", async () => {
    const harness = createHarness({ superseded: true });
    await start(harness);
    await runWarmerAlarm(harness.deps);
    expect(harness.fills).toEqual([]);
    expect(harness.reports).toEqual(["superseded"]);
    expect(harness.storage.values.size).toBe(0);
    expect(harness.deps.slots.release).toHaveBeenCalled();
  });

  test("checks for a newer version while it fills", async () => {
    let checks = 0;
    const harness = createHarness({ superseded: () => (checks += 1) > 1, fillMs: 20_000 });
    const pages = Array.from({ length: 20 }, (_, i) => `/p${i}`);
    await start(harness, warmJob({ pages, startedAt: harness.clock.now }));
    await runWarmerAlarm(harness.deps);
    expect(harness.reports).toEqual(["running", "superseded"]);
    expect(harness.fills.length).toBeLessThan(40);
  });

  test("keeps at most 6 fills in flight", async () => {
    const harness = createHarness();
    const pages = Array.from({ length: 30 }, (_, i) => `/p${i}`);
    await start(harness, warmJob({ pages, startedAt: harness.clock.now }));
    await runWarmerAlarm(harness.deps);
    expect(harness.fills).toHaveLength(60);
    expect(harness.maxInFlight()).toBeLessThanOrEqual(WARM_FILL_CONCURRENCY);
    expect(harness.maxInFlight()).toBeGreaterThan(1);
  });

  test("saves the cursor after 12 minutes and continues in the next alarm", async () => {
    const harness = createHarness({ fillMs: 60_000 });
    const pages = Array.from({ length: 40 }, (_, i) => `/p${i}`);
    await start(harness, warmJob({ pages, startedAt: harness.clock.now }));
    const startedAt = harness.clock.now;
    await runWarmerAlarm(harness.deps);
    const state = await readWarmerState(harness.storage);
    expect(state?.cursor).toBeGreaterThan(0);
    expect(state?.cursor).toBeLessThan(80);
    expect(harness.clock.now - startedAt).toBeGreaterThanOrEqual(WARM_ALARM_BUDGET_MS);
    expect(harness.storage.alarm).toBe(harness.clock.now);
    expect(harness.deps.slots.release).toHaveBeenCalledTimes(1);
    const firstRun = harness.fills.length;
    await runWarmerAlarm(harness.deps);
    expect(harness.fills.slice(0, firstRun)).toEqual(harness.fills.slice(0, firstRun));
    expect(new Set(harness.fills).size).toBe(harness.fills.length);
  });

  test("waits for the site's fill budget", async () => {
    const harness = createHarness({ budget: 2 });
    await start(harness);
    await runWarmerAlarm(harness.deps);
    expect(harness.fills).toHaveLength(2);
    expect((await readWarmerState(harness.storage))?.cursor).toBe(2);
    expect(harness.storage.alarm).toBe(harness.clock.now + 5 * 60_000);
  });

  test("M36: waits for the saved output, then gives up after 20 minutes", async () => {
    const harness = createHarness({ saved: true, ready: () => false });
    await start(harness);
    await runWarmerAlarm(harness.deps);
    expect(harness.fills).toEqual([]);
    expect(harness.storage.alarm).toBe(harness.clock.now + READINESS_RETRY_MS);
    harness.clock.now += READINESS_MAX_WAIT_MS - 1;
    await runWarmerAlarm(harness.deps);
    expect(harness.reports).toEqual([]);
    harness.clock.now += 1;
    await runWarmerAlarm(harness.deps);
    expect(harness.reports).toEqual(["failed"]);
    expect(harness.fills).toEqual([]);
    expect(harness.storage.values.size).toBe(0);
  });

  test("M36: fills once the manifest exists", async () => {
    let ready = false;
    const harness = createHarness({ saved: true, ready: () => ready });
    await start(harness);
    await runWarmerAlarm(harness.deps);
    ready = true;
    await runWarmerAlarm(harness.deps);
    expect(harness.fills).toHaveLength(4);
    expect(harness.reports).toEqual(["running", "done"]);
  });

  test("probes a sample after the last fill, and re-fills misses once after 90 s", async () => {
    const lost = new Set(["https://docs.example.com/guide#data"]);
    const harness = createHarness({ lost });
    await start(harness);
    await runWarmerAlarm(harness.deps);
    // Never a probe before the key's fill (F38).
    for (const probe of harness.probes) {
      expect(harness.fills).toContain(probe);
    }
    expect(harness.probes).toHaveLength(4);
    expect(harness.reports).toEqual(["running"]);
    expect(harness.storage.alarm).toBe(harness.clock.now + REFILL_DELAY_MS);
    lost.clear();
    await runWarmerAlarm(harness.deps);
    expect(harness.fills.filter((key) => key.endsWith("/guide#data"))).toHaveLength(2);
    expect(harness.reports).toEqual(["running", "done"]);
    expect(harness.storage.values.size).toBe(0);
  });

  test("a newer job replaces the running one; the old run writes nothing", async () => {
    const harness = createHarness();
    await start(harness);
    const fill = harness.deps.fill;
    let replacedAlarm: number | null = null;
    harness.deps.fill = vi.fn(async (call: PublicCacheCall) => {
      if (replacedAlarm === null) {
        replacedAlarm = harness.clock.now + 1;
        await startWarmer(
          harness.storage,
          warmJob({ jobId: OTHER_JOB_ID, startedAt: harness.clock.now }),
          replacedAlarm,
        );
      }
      return fill(call);
    });
    await runWarmerAlarm(harness.deps);
    const state = await readWarmerState(harness.storage);
    expect(state?.job.jobId).toBe(OTHER_JOB_ID);
    expect(state?.cursor).toBe(0);
    // The old run neither cleared nor re-armed the new job.
    expect(harness.storage.alarm).toBe(replacedAlarm);
    expect(harness.reports).not.toContain("done");
  });

  test("keeps the result when the lock cannot be reached, and delivers it later", async () => {
    const harness = createHarness();
    await start(harness);
    const report = harness.deps.lock.report;
    let failOnce = true;
    harness.deps.lock.report = vi.fn(async (job: WarmJob, outcome: WarmOutcome | "running") => {
      if (outcome === "done" && failOnce) {
        failOnce = false;
        throw new Error("lock unavailable");
      }
      return report(job, outcome);
    });
    await runWarmerAlarm(harness.deps);
    expect((await readWarmerState(harness.storage))?.phase).toBe("report");
    await runWarmerAlarm(harness.deps);
    expect(harness.reports).toEqual(["running", "done"]);
    expect(harness.fills).toHaveLength(4);
    expect(harness.storage.values.size).toBe(0);
  });

  test("ends the warmer when the report keeps failing, instead of a 1-minute retry forever", async () => {
    const harness = createHarness();
    await start(harness);
    harness.deps.lock.report = vi.fn(async (_job: WarmJob, outcome: WarmOutcome | "running") => {
      if (outcome === "running") return;
      throw new Error("lock rejects the report");
    });
    await runWarmerAlarm(harness.deps);
    for (let attempt = 0; attempt < 10 && harness.storage.values.size > 0; attempt += 1) {
      harness.clock.now += 60_000;
      await runWarmerAlarm(harness.deps);
    }
    expect(harness.storage.values.size).toBe(0);
    expect(harness.storage.alarm).toBeNull();
    // The first report and 4 retries: 5 failures in a row.
    expect(
      vi.mocked(harness.deps.lock.report).mock.calls.filter(([, outcome]) => outcome !== "running"),
    ).toHaveLength(5);
  });

  test("stops retrying a report once the job is older than the maximum age", async () => {
    const harness = createHarness();
    await start(harness);
    harness.deps.lock.report = vi.fn(async (_job: WarmJob, outcome: WarmOutcome | "running") => {
      if (outcome === "done") throw new Error("lock unavailable");
    });
    await runWarmerAlarm(harness.deps);
    expect((await readWarmerState(harness.storage))?.phase).toBe("report");
    harness.clock.now += 4 * 60 * 60_000;
    await runWarmerAlarm(harness.deps);
    expect(harness.storage.values.size).toBe(0);
    expect(harness.storage.alarm).toBeNull();
    expect(
      vi.mocked(harness.deps.lock.report).mock.calls.filter(([, outcome]) => outcome === "done"),
    ).toHaveLength(1);
  });

  test("waits longer for each slot denial in a row, at most 2 minutes, then stops writing (F2)", async () => {
    const harness = createHarness({ slots: false });
    await start(harness);
    const put = vi.spyOn(harness.storage, "put");
    const waits: number[] = [];
    for (let run = 0; run < 7; run += 1) {
      const before = harness.clock.now;
      await runWarmerAlarm(harness.deps);
      waits.push((harness.storage.alarm ?? 0) - before);
      harness.clock.now = harness.storage.alarm ?? harness.clock.now;
    }
    expect(waits).toEqual([30_000, 60_000, 120_000, 120_000, 120_000, 120_000, 120_000]);
    // One write per denial until the wait is at its maximum, then none.
    expect(put).toHaveBeenCalledTimes(MAX_SLOT_WAITS);
    expect(harness.fills).toEqual([]);
    expect(slotRetryDelay(1)).toBe(SLOT_RETRY_MS);
    expect(slotRetryDelay(MAX_SLOT_WAITS - 1)).toBeLessThan(SLOT_RETRY_MAX_MS);
    expect(slotRetryDelay(MAX_SLOT_WAITS)).toBe(SLOT_RETRY_MAX_MS);
  });

  test("a granted slot resets the wait and stores no count (F2, R2)", async () => {
    let free = false;
    const harness = createHarness({ fillMs: 5 * 60_000 });
    harness.deps.slots.acquire = vi.fn(async () => free);
    await start(harness);
    await runWarmerAlarm(harness.deps);
    await runWarmerAlarm(harness.deps);
    expect((await readWarmerState(harness.storage))?.slotWaits).toBe(2);
    free = true;
    await runWarmerAlarm(harness.deps);
    // The run used its time budget and saved its progress, without the key.
    expect((await readWarmerState(harness.storage))?.cursor).toBeGreaterThan(0);
    expect(harness.storage.values.get("state")).not.toHaveProperty("slotWaits");
  });

  test("counts only alarm errors in a row: a good run starts the count again (R3)", async () => {
    const harness = createHarness({ fillMs: 5 * 60_000 });
    await start(harness);
    let failing = true;
    harness.deps.isSuperseded = vi.fn(async () => {
      if (failing) throw new Error("API down");
      return false;
    });
    const runAlarms = async (count: number) => {
      for (let run = 0; run < count; run += 1) {
        await runWarmerAlarm(harness.deps);
        harness.clock.now += 60_000;
      }
    };
    await runAlarms(4);
    expect((await readWarmerState(harness.storage))?.failures).toBe(4);
    failing = false;
    await runAlarms(1);
    expect(await readWarmerState(harness.storage)).toMatchObject({ phase: "fill", failures: 0 });
    failing = true;
    await runAlarms(4);
    // 8 errors in all, but never 5 in a row: the job goes on.
    expect(await readWarmerState(harness.storage)).toMatchObject({ phase: "fill", failures: 4 });
    expect(harness.reports).not.toContain("failed");
  });

  test("five alarm errors in a row end the job as failed, and the report still gets sent (R3)", async () => {
    const harness = createHarness();
    await start(harness);
    let errors = 5;
    harness.deps.isSuperseded = vi.fn(async () => {
      if (errors === 0) return false;
      errors -= 1;
      throw new Error("API down");
    });
    for (let run = 0; run < 6; run += 1) {
      await runWarmerAlarm(harness.deps);
      harness.clock.now += 60_000;
    }
    expect(harness.reports).toEqual(["failed"]);
    expect(harness.storage.values.size).toBe(0);
  });

  test("an error that keeps coming in the report phase ends the warmer after 5 (R3)", async () => {
    const harness = createHarness();
    await start(harness);
    const report = harness.deps.lock.report;
    let reportFailures = 1;
    harness.deps.lock.report = vi.fn(async (job: WarmJob, outcome: WarmOutcome | "running") => {
      if (outcome === "done" && reportFailures > 0) {
        reportFailures -= 1;
        throw new Error("lock unavailable");
      }
      return report(job, outcome);
    });
    // Any error outside the report call itself: here the log line after it.
    vi.mocked(console.info).mockImplementation((line?: unknown) => {
      if (typeof line === "string" && line.includes('"outcome":"done"')) {
        throw new Error("log sink down");
      }
    });
    let alarms = 0;
    while (alarms < 20 && harness.storage.values.size > 0) {
      await runWarmerAlarm(harness.deps);
      harness.clock.now += 60_000;
      alarms += 1;
    }
    // The fill run with the failed report, then 4 report runs that fail.
    expect(alarms).toBe(5);
    expect(harness.storage.values.size).toBe(0);
    expect(harness.storage.alarm).toBeNull();
  });

  test("an alarm error drops the slot-wait count (R2, R3)", async () => {
    const harness = createHarness();
    let denials = 2;
    harness.deps.slots.acquire = vi.fn(async () => {
      if (denials === 0) throw new Error("control object unreachable");
      denials -= 1;
      return false;
    });
    await start(harness);
    await runWarmerAlarm(harness.deps);
    await runWarmerAlarm(harness.deps);
    expect((await readWarmerState(harness.storage))?.slotWaits).toBe(2);
    await runWarmerAlarm(harness.deps);
    expect(harness.storage.values.get("state")).not.toHaveProperty("slotWaits");
    expect((await readWarmerState(harness.storage))?.failures).toBe(1);
  });

  test("earlier alarm errors do not cut short the final report's retries (R3)", async () => {
    const harness = createHarness();
    await start(harness);
    let errors = 4;
    harness.deps.isSuperseded = vi.fn(async () => {
      if (errors === 0) return false;
      errors -= 1;
      throw new Error("API down");
    });
    const report = harness.deps.lock.report;
    let reportFailures = 1;
    harness.deps.lock.report = vi.fn(async (job: WarmJob, outcome: WarmOutcome | "running") => {
      if (outcome === "done" && reportFailures > 0) {
        reportFailures -= 1;
        throw new Error("lock unavailable");
      }
      return report(job, outcome);
    });
    for (let run = 0; run < 8 && harness.storage.values.size > 0; run += 1) {
      await runWarmerAlarm(harness.deps);
      harness.clock.now += 60_000;
    }
    expect(harness.reports).toEqual(["running", "done"]);
    expect(harness.storage.values.size).toBe(0);
  });

  test("the same job again keeps the warmer's progress (F4)", async () => {
    const harness = createHarness({ fillMs: 5 * 60_000 });
    const job = await start(harness);
    await runWarmerAlarm(harness.deps);
    const progressed = await readWarmerState(harness.storage);
    expect(progressed?.cursor).toBeGreaterThan(0);
    // A redelivered message starts the same job with a new start time.
    await startWarmer(harness.storage, { ...job, startedAt: harness.clock.now }, harness.clock.now);
    expect((await readWarmerState(harness.storage))?.cursor).toBe(progressed?.cursor);
    // A different job still replaces it.
    await startWarmer(harness.storage, warmJob({ jobId: OTHER_JOB_ID, startedAt: harness.clock.now }), harness.clock.now);
    expect((await readWarmerState(harness.storage))?.cursor).toBe(0);
  });

  test("verifies in the next alarm when the fills used the whole budget", async () => {
    const harness = createHarness({ fillMs: 3 * 60_000 });
    await start(harness);
    await runWarmerAlarm(harness.deps);
    const state = await readWarmerState(harness.storage);
    expect(state).toMatchObject({ phase: "fill", cursor: 4 });
    expect(harness.probes).toEqual([]);
    await runWarmerAlarm(harness.deps);
    expect(harness.probes.length).toBeGreaterThan(0);
    expect(harness.reports).toContain("done");
  });

  test("an old job ends as failed", async () => {
    const harness = createHarness();
    harness.clock.now = 24 * 60 * 60_000;
    await start(harness, warmJob({ startedAt: harness.clock.now - 4 * 60 * 60_000 }));
    await runWarmerAlarm(harness.deps);
    expect(harness.reports).toEqual(["failed"]);
    expect(harness.fills).toEqual([]);
  });

  test("FC-H2: sends a heartbeat on every alarm, also while it waits for a slot or saved output", async () => {
    const slotWait = createHarness({ slots: false });
    await start(slotWait);
    await runWarmerAlarm(slotWait.deps);
    slotWait.clock.now += SLOT_RETRY_MS;
    await runWarmerAlarm(slotWait.deps);
    expect(slotWait.deps.lock.heartbeat).toHaveBeenCalledTimes(2);

    const readinessWait = createHarness({ saved: true, ready: () => false });
    await start(readinessWait);
    await runWarmerAlarm(readinessWait.deps);
    readinessWait.clock.now += READINESS_RETRY_MS;
    await runWarmerAlarm(readinessWait.deps);
    expect(readinessWait.deps.lock.heartbeat).toHaveBeenCalledTimes(2);
  });

  test("FC-H2: a job the lock ended stops at once: no slot, no report, storage deleted", async () => {
    const harness = createHarness({ current: () => false });
    await start(harness);
    await runWarmerAlarm(harness.deps);
    expect(harness.deps.slots.acquire).not.toHaveBeenCalled();
    expect(harness.deps.slots.release).not.toHaveBeenCalled();
    expect(harness.reports).toEqual([]);
    expect(harness.fills).toEqual([]);
    expect(harness.storage.values.size).toBe(0);
    expect(harness.storage.alarm).toBeNull();
  });

  test("FC-H2: job_ended on a reservation stops the warmer instead of a 5-minute spin", async () => {
    const harness = createHarness({ ended: () => true });
    await start(harness);
    await runWarmerAlarm(harness.deps);
    expect(harness.fills).toEqual([]);
    expect(harness.reports).toEqual(["running"]);
    expect(harness.storage.values.size).toBe(0);
    expect(harness.storage.alarm).toBeNull();
    // It held a slot for this run and gives it back.
    expect(harness.deps.slots.release).toHaveBeenCalledTimes(1);
  });

  test("FC-H2: an unreachable lock does not stop the warmer", async () => {
    const harness = createHarness();
    harness.deps.lock.heartbeat = vi.fn(async () => {
      throw new Error("lock unavailable");
    });
    await start(harness);
    await runWarmerAlarm(harness.deps);
    expect(harness.reports).toEqual(["running", "done"]);
  });

  test("units are page-major across hostnames; samples spread evenly", () => {
    const job = warmJob({
      targets: [
        { hostname: "a.example.com", resolution: siteResolution({ hostname: "a.example.com" }), resolvedAt: 1 },
        { hostname: "b.example.com", resolution: siteResolution({ hostname: "b.example.com" }), resolvedAt: 1 },
      ],
      pages: ["/", "/x"],
    });
    expect(Array.from({ length: unitCount(job) }, (_, i) => unitAt(job, i))).toEqual([
      { hostname: "a.example.com", pathname: "/", representation: "html" },
      { hostname: "a.example.com", pathname: "/", representation: "data" },
      { hostname: "b.example.com", pathname: "/", representation: "html" },
      { hostname: "b.example.com", pathname: "/", representation: "data" },
      { hostname: "a.example.com", pathname: "/x", representation: "html" },
      { hostname: "a.example.com", pathname: "/x", representation: "data" },
      { hostname: "b.example.com", pathname: "/x", representation: "html" },
      { hostname: "b.example.com", pathname: "/x", representation: "data" },
    ]);
    expect(sampleIndexes(3, 20)).toEqual([0, 1, 2]);
    expect(sampleIndexes(100, 4)).toEqual([0, 25, 50, 75]);
  });
});
