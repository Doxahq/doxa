import {
  docsWarmStateKey,
  docsWarmStateSchema,
} from "@doxahq/contracts/docs-warm-state";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", async () => (await import("./fixtures")).cloudflareWorkersMock());

import { readPoolWarmState } from "../../src/warm-state";
import { DocsWarmLock, nextLockAlarm } from "../../src/warm/docs-warm-lock";
import { WARM_JOB_MAX_AGE_MS } from "../../src/warm/warm-job";
import {
  EMPTY_WARM_LOCK_STATE,
  WARM_DONE_RECORD_MS,
  WARM_LOCK_LEASE_MS,
  describeWarmStatus,
  expireLease,
  heartbeatWarmJob,
  nextBudgetWindow,
  reportWarmPool,
  reserveWarmFills,
  submitWarmJob,
  type WarmLockState,
} from "../../src/warm/warm-lock-state";
import {
  JOB_ID,
  MemoryStorage,
  OTHER_JOB_ID,
  OTHER_RELEASE,
  OTHER_TARGET,
  RELEASE,
  TARGET,
  THIRD_JOB_ID,
  objectState,
  warmMessage,
} from "./fixtures";

afterEach(() => {
  vi.restoreAllMocks();
});

const POOLS = ["eu-west", "us-east"] as const;

function running(now = 0): WarmLockState {
  return submitWarmJob(EMPTY_WARM_LOCK_STATE, {
    message: warmMessage(),
    target: TARGET,
    pools: [...POOLS],
    now,
  }).state;
}

function report(
  state: WarmLockState,
  pool: (typeof POOLS)[number],
  outcome: "running" | "done" | "failed" | "superseded",
  now = 100,
  deployedReleaseId: string | null = RELEASE,
  jobId = JOB_ID,
) {
  return reportWarmPool(state, { jobId, pool, report: outcome, deployedReleaseId, now });
}

describe("site lock: submit", () => {
  test("grants a job when nothing runs", () => {
    const result = submitWarmJob(EMPTY_WARM_LOCK_STATE, {
      message: warmMessage(),
      target: TARGET,
      pools: [...POOLS],
      now: 0,
    });
    expect(result.result).toEqual({ outcome: "granted", tookOver: false });
    expect(result.state.running).toMatchObject({
      jobId: JOB_ID,
      target: TARGET,
      releaseId: RELEASE,
      leaseExpiresAt: WARM_LOCK_LEASE_MS,
      pools: { "eu-west": { state: "pending" }, "us-east": { state: "pending" } },
    });
  });

  test("continues the same job and drops a duplicate target", () => {
    const state = running();
    const again = submitWarmJob(state, { message: warmMessage(), target: TARGET, pools: [...POOLS], now: 1 });
    expect(again.result.outcome).toBe("continued");
    const duplicate = submitWarmJob(state, {
      message: warmMessage({ jobId: OTHER_JOB_ID }),
      target: TARGET,
      pools: [...POOLS],
      now: 1,
    });
    expect(duplicate.result.outcome).toBe("duplicate");
    expect(duplicate.state.pending).toBeNull();
  });

  test("keeps the newest pending target and always answers (no busy retry)", () => {
    let state = running();
    const second = submitWarmJob(state, {
      message: warmMessage({ jobId: OTHER_JOB_ID, enqueuedAt: 2_000 }),
      target: OTHER_TARGET,
      pools: [...POOLS],
      now: 1,
    });
    expect(second.result.outcome).toBe("pending");
    state = second.state;
    const older = submitWarmJob(state, {
      message: warmMessage({ jobId: THIRD_JOB_ID, enqueuedAt: 1_500 }),
      target: "f".repeat(64),
      pools: [...POOLS],
      now: 2,
    });
    expect(older.result.outcome).toBe("stale");
    expect(older.state.pending?.jobId).toBe(OTHER_JOB_ID);
    const newer = submitWarmJob(state, {
      message: warmMessage({ jobId: THIRD_JOB_ID, enqueuedAt: 3_000 }),
      target: "f".repeat(64),
      pools: [...POOLS],
      now: 2,
    });
    expect(newer.result.outcome).toBe("pending");
    expect(newer.state.pending?.jobId).toBe(THIRD_JOB_ID);
  });

  test("starts the pending job when the running one ends", () => {
    let state = submitWarmJob(running(), {
      message: warmMessage({ jobId: OTHER_JOB_ID, enqueuedAt: 2_000 }),
      target: OTHER_TARGET,
      pools: [...POOLS],
      now: 1,
    }).state;
    state = report(state, "eu-west", "done").state;
    const last = report(state, "us-east", "failed");
    expect(last.effects.startPending?.jobId).toBe(OTHER_JOB_ID);
    expect(last.effects.finished).toEqual({ jobId: JOB_ID, reason: "completed" });
    expect(last.state.running).toBeNull();
    expect(last.state.pending).toBeNull();
  });

  test("drops a target that finished less than an hour ago", () => {
    let state = report(running(), "eu-west", "done").state;
    state = report(state, "us-east", "done", 200).state;
    const again = (now: number) =>
      submitWarmJob(state, {
        message: warmMessage({ jobId: OTHER_JOB_ID }),
        target: TARGET,
        pools: [...POOLS],
        now,
      }).result.outcome;
    expect(again(200 + WARM_DONE_RECORD_MS - 1)).toBe("done_recently");
    expect(again(200 + WARM_DONE_RECORD_MS + 1)).toBe("granted");
  });

  test("a superseded job leaves no done record", () => {
    let state = report(running(), "eu-west", "superseded").state;
    const end = report(state, "us-east", "done");
    expect(end.effects.finished?.reason).toBe("superseded");
    state = end.state;
    expect(state.done).toEqual({});
  });

  test("takes over after the 30-minute lease", () => {
    const state = running();
    const before = submitWarmJob(state, {
      message: warmMessage({ jobId: OTHER_JOB_ID }),
      target: OTHER_TARGET,
      pools: [...POOLS],
      now: WARM_LOCK_LEASE_MS - 1,
    });
    expect(before.result.outcome).toBe("pending");
    const after = submitWarmJob(state, {
      message: warmMessage({ jobId: OTHER_JOB_ID }),
      target: OTHER_TARGET,
      pools: [...POOLS],
      now: WARM_LOCK_LEASE_MS,
    });
    expect(after.result).toEqual({ outcome: "granted", tookOver: true });
    expect(after.state.running?.jobId).toBe(OTHER_JOB_ID);
    expect(after.state.last?.pools["eu-west"]?.state).toBe("failed");
    expect(after.effects.startPending).toBeNull();
  });

  test("a fill reservation renews the lease of a job that makes progress", () => {
    const state = reserveWarmFills(running(), {
      jobId: JOB_ID,
      count: 6,
      perHour: 100,
      now: WARM_LOCK_LEASE_MS - 1,
    }).state;
    expect(state.running?.leaseExpiresAt).toBe(2 * WARM_LOCK_LEASE_MS - 1);
    expect(expireLease(state, WARM_LOCK_LEASE_MS + 1).state.running?.jobId).toBe(JOB_ID);
  });

  test("FC-H2: heartbeats keep a waiting job alive past the 30-minute lease", () => {
    let state = running(0);
    // A warmer that waits for a slot sends one heartbeat per alarm (30 s).
    for (let now = 30_000; now <= 2 * WARM_LOCK_LEASE_MS; now += 30_000) {
      const beat = heartbeatWarmJob(state, { jobId: JOB_ID, now });
      expect(beat.result.current).toBe(true);
      state = beat.state;
    }
    expect(expireLease(state, 2 * WARM_LOCK_LEASE_MS + 1).state.running?.jobId).toBe(JOB_ID);
    // Without heartbeats the same job would have ended.
    expect(expireLease(running(0), 2 * WARM_LOCK_LEASE_MS).state.running).toBeNull();
  });

  test("FC-H2: a heartbeat never renews past the 3-hour job age", () => {
    let state = running(0);
    for (let now = 10 * 60_000; now < WARM_JOB_MAX_AGE_MS; now += 10 * 60_000) {
      state = heartbeatWarmJob(state, { jobId: JOB_ID, now }).state;
    }
    const beat = heartbeatWarmJob(state, { jobId: JOB_ID, now: WARM_JOB_MAX_AGE_MS - 60_000 });
    expect(beat.result.current).toBe(true);
    expect(beat.state.running?.leaseExpiresAt).toBe(WARM_JOB_MAX_AGE_MS);
    const late = heartbeatWarmJob(beat.state, { jobId: JOB_ID, now: WARM_JOB_MAX_AGE_MS });
    expect(late.result.current).toBe(false);
    expect(late.effects.finished?.reason).toBe("expired");
  });

  test("FC-H2: a heartbeat of another job tells the warmer to stop", () => {
    const beat = heartbeatWarmJob(running(0), { jobId: OTHER_JOB_ID, now: 1 });
    expect(beat.result.current).toBe(false);
    expect(beat.state.running?.jobId).toBe(JOB_ID);
    expect(heartbeatWarmJob(EMPTY_WARM_LOCK_STATE, { jobId: JOB_ID, now: 1 }).result.current).toBe(false);
  });

  test("FC-L5: a takeover keeps a newer pending job and drops an older incoming one", () => {
    const withPending = submitWarmJob(running(0), {
      message: warmMessage({ jobId: OTHER_JOB_ID, enqueuedAt: 5_000 }),
      target: OTHER_TARGET,
      pools: [...POOLS],
      now: 1,
    }).state;
    // A redelivered old message arrives after the lease ended.
    const redelivered = submitWarmJob(withPending, {
      message: warmMessage({ jobId: THIRD_JOB_ID, enqueuedAt: 1_000 }),
      target: "f".repeat(64),
      pools: [...POOLS],
      now: WARM_LOCK_LEASE_MS,
    });
    expect(redelivered.result).toEqual({ outcome: "stale", tookOver: true });
    expect(redelivered.effects.startPending?.jobId).toBe(OTHER_JOB_ID);
    expect(redelivered.state.running).toBeNull();
    expect(redelivered.state.pending?.jobId).toBe(OTHER_JOB_ID);
  });

  test("FC-L5: a takeover by a newer message runs it and drops the older pending one", () => {
    const withPending = submitWarmJob(running(0), {
      message: warmMessage({ jobId: OTHER_JOB_ID, enqueuedAt: 5_000 }),
      target: OTHER_TARGET,
      pools: [...POOLS],
      now: 1,
    }).state;
    const newer = submitWarmJob(withPending, {
      message: warmMessage({ jobId: THIRD_JOB_ID, enqueuedAt: 9_000 }),
      target: "f".repeat(64),
      pools: [...POOLS],
      now: WARM_LOCK_LEASE_MS,
    });
    expect(newer.result).toEqual({ outcome: "granted", tookOver: true });
    expect(newer.state.running?.jobId).toBe(THIRD_JOB_ID);
    expect(newer.state.pending).toBeNull();
    expect(newer.effects.startPending).toBeNull();
  });

  test("an expired lease starts the pending job", () => {
    const state = submitWarmJob(running(), {
      message: warmMessage({ jobId: OTHER_JOB_ID, enqueuedAt: 5 }),
      target: OTHER_TARGET,
      pools: [...POOLS],
      now: 1,
    }).state;
    expect(expireLease(state, WARM_LOCK_LEASE_MS - 1).effects.startPending).toBeNull();
    const expired = expireLease(state, WARM_LOCK_LEASE_MS);
    expect(expired.effects.finished?.reason).toBe("expired");
    expect(expired.effects.startPending?.jobId).toBe(OTHER_JOB_ID);
  });
});

describe("site lock: warm-state writer", () => {
  test("writes exactly the contract record for a done pool of the deployed release", () => {
    const result = report(running(), "eu-west", "done", 1_234);
    expect(result.effects.flushWarmState).toBe(true);
    expect(result.state.warmState).toEqual({
      format: 1,
      releaseId: RELEASE,
      pools: { "eu-west": 1_234 },
    });
    expect(docsWarmStateSchema.parse(result.state.warmState)).toEqual(result.state.warmState);
  });

  test("adds pools of the same release and replaces another release's record", () => {
    let state = report(running(), "eu-west", "done", 10).state;
    state = report(state, "us-east", "done", 20).state;
    expect(state.warmState?.pools).toEqual({ "eu-west": 10, "us-east": 20 });
    const next = submitWarmJob(state, {
      message: warmMessage({ jobId: OTHER_JOB_ID, releaseId: OTHER_RELEASE }),
      target: OTHER_TARGET,
      pools: ["eu-west"],
      now: 30,
    }).state;
    const replaced = report(next, "eu-west", "done", 40, OTHER_RELEASE, OTHER_JOB_ID).state;
    expect(replaced.warmState).toEqual({
      format: 1,
      releaseId: OTHER_RELEASE,
      pools: { "eu-west": 40 },
    });
  });

  test("never writes for a release that is not deployed, nor for another job", () => {
    const stale = report(running(), "eu-west", "done", 10, OTHER_RELEASE);
    expect(stale.effects.flushWarmState).toBe(false);
    expect(stale.state.warmState).toBeNull();
    const other = report(running(), "eu-west", "done", 10, RELEASE, OTHER_JOB_ID);
    expect(other.result.accepted).toBe(false);
    expect(other.state.warmState).toBeNull();
  });

  test("failed and running pools are not warm", () => {
    let state = report(running(), "eu-west", "running").state;
    state = report(state, "us-east", "failed").state;
    expect(state.warmState).toBeNull();
  });
});

describe("site lock: budget and status", () => {
  test("grants fills up to the hourly budget, then the next window", () => {
    let state = running(0);
    const first = reserveWarmFills(state, { jobId: JOB_ID, count: 6, perHour: 10, now: 1 });
    expect(first.result).toEqual({ status: "granted", count: 6 });
    state = first.state;
    const second = reserveWarmFills(state, { jobId: JOB_ID, count: 6, perHour: 10, now: 2 });
    expect(second.result).toEqual({ status: "granted", count: 4 });
    const third = reserveWarmFills(second.state, { jobId: JOB_ID, count: 6, perHour: 10, now: 3 });
    expect(third.result).toEqual({ status: "budget_exhausted", retryAt: nextBudgetWindow(3) });
    // A warmer that waits for the next window keeps the lease with heartbeats.
    const waited = [20, 40].reduce(
      (current, minutes) => heartbeatWarmJob(current, { jobId: JOB_ID, now: minutes * 60_000 }).state,
      third.state,
    );
    const later = reserveWarmFills(waited, {
      jobId: JOB_ID,
      count: 6,
      perHour: 10,
      now: nextBudgetWindow(3),
    });
    expect(later.result).toEqual({ status: "granted", count: 6 });
    expect(
      reserveWarmFills(state, { jobId: OTHER_JOB_ID, count: 6, perHour: 10, now: 2 }).result,
    ).toEqual({ status: "job_ended" });
  });

  test("FC-H2: a job whose lease ended gets job_ended, not an empty grant", () => {
    const result = reserveWarmFills(running(0), {
      jobId: JOB_ID,
      count: 6,
      perHour: 10,
      now: WARM_LOCK_LEASE_MS,
    });
    expect(result.result).toEqual({ status: "job_ended" });
    expect(result.effects.finished).toEqual({ jobId: JOB_ID, reason: "expired" });
    expect(result.state.running).toBeNull();
  });

  test("describes the running job, then the last one for an hour", () => {
    let state = report(running(5), "eu-west", "running", 6).state;
    expect(describeWarmStatus(state, "site-1", 7)).toEqual({
      siteId: "site-1",
      releaseId: RELEASE,
      startedAt: 5,
      finishedAt: null,
      pools: [
        { pool: "us-east", state: "pending", updatedAt: 5 },
        { pool: "eu-west", state: "running", updatedAt: 6 },
      ],
    });
    state = report(state, "eu-west", "done", 8).state;
    state = report(state, "us-east", "done", 9).state;
    expect(describeWarmStatus(state, "site-1", 10)).toMatchObject({
      finishedAt: 9,
      pools: [
        { pool: "us-east", state: "done" },
        { pool: "eu-west", state: "done" },
      ],
    });
    expect(describeWarmStatus(state, "site-1", 9 + WARM_DONE_RECORD_MS + 1)).toEqual({
      siteId: "site-1",
      releaseId: null,
      startedAt: null,
      finishedAt: null,
      pools: [],
    });
  });
});

describe("DocsWarmLock", () => {
  function createLock() {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const storage = new MemoryStorage();
    const kv = new Map<string, string>();
    const sent: unknown[] = [];
    const env = {
      DOXA_RENDERER_RELEASE_ID: RELEASE,
      DOCS_HOSTNAME_MAP: {
        get: vi.fn(async (key: string) => kv.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => {
          kv.set(key, value);
        }),
      },
      DOCS_WARM_PUBLISH_QUEUE: { send: vi.fn(async (body: unknown) => void sent.push(body)) },
    };
    const lock = new DocsWarmLock(objectState(storage) as never, env as never);
    return { lock, storage, kv, sent, env };
  }

  test("writes warm:{siteId} that the dispatcher reader accepts, batched by an alarm", async () => {
    const { lock, storage, kv, env } = createLock();
    await lock.submit({ message: warmMessage(), target: TARGET, pools: ["eu-west", "us-east"] });
    await lock.report({ siteId: "site-1", jobId: JOB_ID, pool: "eu-west", report: "done" });
    expect(kv.size).toBe(0);
    expect(storage.alarm).not.toBeNull();
    await lock.alarm();
    const text = kv.get(docsWarmStateKey("site-1"));
    expect(text).toBeDefined();
    expect(docsWarmStateSchema.parse(JSON.parse(text ?? "null"))).toMatchObject({
      format: 1,
      releaseId: RELEASE,
    });
    expect(
      await readPoolWarmState({
        store: env.DOCS_HOSTNAME_MAP,
        siteId: "site-1",
        releaseId: RELEASE,
        pool: "eu-west",
      }),
    ).toBe("warm");
    expect(
      await readPoolWarmState({
        store: env.DOCS_HOSTNAME_MAP,
        siteId: "site-1",
        releaseId: RELEASE,
        pool: "us-east",
      }),
    ).toBe("cold");
  });

  test("sends the pending message to the publish queue when the job ends", async () => {
    const { lock, sent } = createLock();
    await lock.submit({ message: warmMessage(), target: TARGET, pools: ["eu-west"] });
    const pending = warmMessage({ jobId: OTHER_JOB_ID, enqueuedAt: 9_000 });
    expect(await lock.submit({ message: pending, target: OTHER_TARGET, pools: ["eu-west"] })).toEqual({
      outcome: "pending",
    });
    await lock.report({ siteId: "site-1", jobId: JOB_ID, pool: "eu-west", report: "done" });
    expect(sent).toEqual([pending]);
    expect(await lock.getStatus({ siteId: "site-1" })).toMatchObject({
      releaseId: RELEASE,
      pools: [{ pool: "eu-west", state: "done" }],
    });
  });

  test("keeps the pending message when the send fails, and resends from the alarm", async () => {
    const { lock, env, sent } = createLock();
    await lock.submit({ message: warmMessage(), target: TARGET, pools: ["eu-west"] });
    await lock.submit({
      message: warmMessage({ jobId: OTHER_JOB_ID, enqueuedAt: 9_000 }),
      target: OTHER_TARGET,
      pools: ["eu-west"],
    });
    env.DOCS_WARM_PUBLISH_QUEUE.send.mockRejectedValueOnce(new Error("queue down"));
    await lock.report({ siteId: "site-1", jobId: JOB_ID, pool: "eu-west", report: "failed" });
    expect(sent).toEqual([]);
    await lock.alarm();
    expect(sent).toHaveLength(1);
  });

  test("FC-H2: heartbeat and reserveFills over RPC", async () => {
    const { lock } = createLock();
    await lock.submit({ message: warmMessage(), target: TARGET, pools: ["eu-west"] });
    expect(await lock.heartbeat({ siteId: "site-1", jobId: JOB_ID })).toEqual({ current: true });
    expect(await lock.heartbeat({ siteId: "site-1", jobId: OTHER_JOB_ID })).toEqual({ current: false });
    expect(await lock.reserveFills({ siteId: "site-1", jobId: JOB_ID, count: 3 })).toEqual({
      status: "granted",
      count: 3,
    });
    expect(await lock.reserveFills({ siteId: "site-1", jobId: OTHER_JOB_ID, count: 3 })).toEqual({
      status: "job_ended",
    });
  });

  test("FC-A: alarm() sets its next alarm directly, whatever getAlarm() returns", async () => {
    const { lock, storage, env } = createLock();
    await lock.submit({ message: warmMessage(), target: TARGET, pools: ["eu-west", "us-east"] });
    await lock.report({ siteId: "site-1", jobId: JOB_ID, pool: "eu-west", report: "done" });
    // The worst case: inside alarm() getAlarm() reports the running alarm's past time.
    const firing = storage.alarm ?? 0;
    vi.spyOn(storage, "getAlarm").mockResolvedValue(firing);
    env.DOCS_HOSTNAME_MAP.put.mockRejectedValueOnce(new Error("KV down"));
    const before = Date.now();
    await lock.alarm();
    // The failed write is retried within seconds; the read-min logic would set nothing.
    expect(storage.alarm).not.toBe(firing);
    expect(storage.alarm ?? 0).toBeGreaterThanOrEqual(before);
    expect(storage.alarm ?? Infinity).toBeLessThan(before + 60_000);
  });

  test("FC-A: nextLockAlarm keeps the earliest need of the state", () => {
    const state = running(0);
    expect(nextLockAlarm(state, 10)).toBe(WARM_LOCK_LEASE_MS);
    expect(nextLockAlarm({ ...state, warmStateDirty: true }, 10)).toBe(5_010);
    expect(nextLockAlarm(EMPTY_WARM_LOCK_STATE, 10)).toBe(Number.POSITIVE_INFINITY);
    expect(nextLockAlarm({ ...EMPTY_WARM_LOCK_STATE, pending: warmMessage() }, 10)).toBe(60_010);
  });

  test("rejects malformed input", async () => {
    const { lock } = createLock();
    await expect(
      lock.submit({ message: { ...warmMessage(), releaseId: "x" }, target: TARGET, pools: ["eu-west"] }),
    ).rejects.toThrow();
    await expect(
      lock.report({ siteId: "site-1", jobId: JOB_ID, pool: "mars", report: "done" }),
    ).rejects.toThrow();
  });
});
