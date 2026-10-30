import { z } from "zod";

import type { PublicCacheCall } from "../public-cache-calls";
import type { FillOutcome, WarmUnit } from "./warm-fill";
import { runLimited } from "./warm-fill";
import {
  WARM_JOB_MAX_AGE_MS,
  warmJobSchema,
  type WarmJob,
  type WarmOutcome,
  type WarmTarget,
} from "./warm-job";
import type { FillReservation } from "./warm-lock-state";
import { describeWarmError, logWarm } from "./warm-log";
import type { WarmStorage } from "./warm-storage";
import { readStored } from "./warm-storage";

/**
 * One regional warmer's alarm loop (`DocsRegionalWarmer`, spec § 7.2). The
 * Durable Object lives in its pool, so every fill lands in that pool's upper
 * tier. Each alarm run holds one global slot, fills up to 6 keys at a time
 * for up to 12 minutes, saves its cursor and re-arms. After the last fill it
 * probes a sample and fills the misses once more (F41). Its dependencies are
 * injected, so tests run it on stubs.
 */

export const WARM_FILL_CONCURRENCY = 6;
export const WARM_ALARM_BUDGET_MS = 12 * 60_000;
export const SLOT_RETRY_MS = 30_000;
/**
 * The longest wait between slot tries. Waiting warmers back off, so a burst
 * of many sites does not wake every waiting warmer twice a minute, but a
 * freed slot does not stay empty for long.
 */
export const SLOT_RETRY_MAX_MS = 2 * 60_000;
/** Slot denials stop counting here: the wait is at its maximum (30 s, 60 s, 2 minutes). */
export const MAX_SLOT_WAITS = 3;
export const READINESS_RETRY_MS = 60_000;
export const READINESS_MAX_WAIT_MS = 20 * 60_000;
/** A probe miss blocks stores of that key for over a minute (F38). */
export const REFILL_DELAY_MS = 90_000;
export const VERIFY_SAMPLE_SIZE = 20;
const SUPERSEDE_CHECK_MS = 60_000;
const FAILURE_RETRY_MS = 60_000;
const MAX_ALARM_FAILURES = 5;
export { WARM_JOB_MAX_AGE_MS };
const BUDGET_RETRY_MS = 5 * 60_000;
/**
 * Fills reserved from the site lock per call. The lock may sit in another
 * pool, so a warmer asks once per 60 fills, not once per batch.
 */
export const FILL_RESERVATION = 60;

const countsSchema = z
  .object({
    filled: z.number().int().nonnegative(),
    notFilled: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    verified: z.number().int().nonnegative(),
    verifyMisses: z.number().int().nonnegative(),
    refilled: z.number().int().nonnegative(),
  })
  .strict();

export type WarmCounts = z.infer<typeof countsSchema>;

const warmerStateSchema = z
  .object({
    job: warmJobSchema,
    phase: z.enum(["fill", "refill", "report"]),
    cursor: z.number().int().nonnegative(),
    /** Fills reserved from the site's hourly budget and not used yet. */
    reserved: z.number().int().nonnegative(),
    refill: z.array(z.number().int().nonnegative()).max(VERIFY_SAMPLE_SIZE),
    readinessSince: z.number().int().nonnegative().nullable(),
    reportedRunning: z.boolean(),
    finalOutcome: z.enum(["done", "failed", "superseded"]).nullable(),
    failures: z.number().int().nonnegative(),
    counts: countsSchema,
    /**
     * Slot denials in a row: the next try waits longer. Absent while there
     * is no denial, so a rolled-back deploy (strict schema) still reads the
     * state.
     */
    slotWaits: z.number().int().nonnegative().optional(),
  })
  .strict();

export type WarmerState = z.infer<typeof warmerStateSchema>;

const STATE_KEY = "state";

const EMPTY_COUNTS: WarmCounts = {
  filled: 0,
  notFilled: 0,
  errors: 0,
  skipped: 0,
  verified: 0,
  verifyMisses: 0,
  refilled: 0,
};

export interface WarmerDeps {
  storage: WarmStorage;
  now(): number;
  /** This warmer's name: the slot holder and the log key. */
  holder: string;
  slots: {
    /** One slot of the global cap, within the site's own cap (FS-L1). */
    acquire(holder: string, siteId: string): Promise<boolean>;
    release(holder: string): Promise<void>;
  };
  lock: {
    report(job: WarmJob, report: "running" | WarmOutcome): Promise<void>;
    /**
     * Keeps the job's lease at the site lock; false when the lock ended the
     * job. Sent on every alarm run, also while the warmer waits (FC-H2).
     */
    heartbeat(job: WarmJob): Promise<boolean>;
    /** Takes up to `count` fills from the site's hourly budget. */
    reserveFills(job: WarmJob, count: number): Promise<FillReservation>;
  };
  /** The live hostname map changed, or the deployed release did. */
  isSuperseded(job: WarmJob): Promise<boolean>;
  selectCalls(
    target: WarmTarget,
    pathname: string,
  ): Promise<{ html: PublicCacheCall; data: PublicCacheCall | null; saved: boolean } | null>;
  /** Is the saved output of this pre-rendered call committed (F21)? */
  isSavedOutputReady(call: PublicCacheCall): Promise<boolean>;
  fill(call: PublicCacheCall): Promise<FillOutcome>;
  probe(call: PublicCacheCall): Promise<boolean>;
}

/**
 * `start()`: a newer job replaces whatever this warmer was doing. The same
 * job again (a redelivered queue message) keeps its progress: restarting at
 * cursor 0 would fill every key a second time.
 */
export async function startWarmer(
  storage: WarmStorage,
  job: WarmJob,
  now: number,
): Promise<void> {
  const parsed = warmJobSchema.parse(job);
  const existing = await readWarmerState(storage);
  if (existing?.job.jobId === parsed.jobId) {
    if ((await storage.getAlarm()) === null) await storage.setAlarm(now);
    return;
  }
  const state: WarmerState = {
    job: parsed,
    phase: "fill",
    cursor: 0,
    reserved: 0,
    refill: [],
    readinessSince: null,
    reportedRunning: false,
    finalOutcome: null,
    failures: 0,
    counts: EMPTY_COUNTS,
  };
  await storage.put(STATE_KEY, state);
  await storage.setAlarm(now);
}

export async function readWarmerState(
  storage: Pick<WarmStorage, "get">,
): Promise<WarmerState | null> {
  return readStored(storage, STATE_KEY, (value) => {
    const parsed = warmerStateSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
}

/**
 * One alarm run. Never throws: a failure re-arms, five in a row end the job.
 * A run that holds a slot and ends without an error resets the count.
 */
export async function runWarmerAlarm(input: WarmerDeps): Promise<void> {
  let deps = input;
  const state = await readWarmerState(deps.storage);
  if (!state) {
    await clearWarmer(deps.storage);
    return;
  }
  // `start()` may replace the job while this run waits on I/O: from then on
  // this run writes nothing.
  deps = { ...deps, storage: guardStorage(deps.storage, state.job.jobId) };
  try {
    await runWithState(deps, state);
  } catch (error) {
    const failures = state.failures + 1;
    logWarm("docs_warm_region", {
      ...jobFacts(state.job, deps.holder),
      outcome: "alarm_error",
      failures,
      error: describeWarmError(error),
    });
    // The report phase already had its tries: stop instead of a retry every minute.
    if (state.phase === "report" && failures >= MAX_ALARM_FAILURES) {
      return abandon(deps, state, "report_errors");
    }
    // The retry comes after FAILURE_RETRY_MS: a later denial backs off from the start.
    const failed = withoutSlotWaits({ ...state, failures });
    // The report phase starts with a count of 0, so the "failed" report gets its own tries.
    const next: WarmerState =
      failures >= MAX_ALARM_FAILURES
        ? { ...failed, failures: 0, phase: "report", finalOutcome: "failed" }
        : failed;
    await deps.storage.put(STATE_KEY, next);
    await deps.storage.setAlarm(deps.now() + FAILURE_RETRY_MS);
  }
}

async function runWithState(deps: WarmerDeps, state: WarmerState): Promise<void> {
  const startedAt = deps.now();
  const tooOld = startedAt - state.job.startedAt > WARM_JOB_MAX_AGE_MS;
  if (state.phase === "report" && state.finalOutcome) {
    // The lock ended an old job long ago (30-minute lease): stop retrying.
    if (tooOld) return abandon(deps, state, "report_too_old");
    return finish(deps, state, state.finalOutcome);
  }
  if (tooOld) return finish(deps, state, "failed", "job_too_old");
  if (!(await sendHeartbeat(deps, state))) return abandon(deps, state, "heartbeat");
  // The control object logs a sample of denials (FC-L10).
  if (!(await deps.slots.acquire(deps.holder, state.job.siteId))) {
    const slotWaits = Math.min((state.slotWaits ?? 0) + 1, MAX_SLOT_WAITS);
    // At the maximum wait the count stays the same: nothing to write.
    if (slotWaits !== state.slotWaits) {
      await deps.storage.put(STATE_KEY, { ...state, slotWaits } satisfies WarmerState);
    }
    await deps.storage.setAlarm(startedAt + slotRetryDelay(slotWaits));
    return;
  }
  try {
    // The first write of this run stores the reset counts. A run that throws
    // instead stores the counts it read, plus one failure.
    const fresh = withoutSlotWaits(state.failures ? { ...state, failures: 0 } : state);
    await runHoldingSlot(deps, fresh, startedAt);
  } finally {
    await deps.slots.release(deps.holder);
  }
}

async function runHoldingSlot(
  deps: WarmerDeps,
  initial: WarmerState,
  startedAt: number,
): Promise<void> {
  let state = initial;
  if (await deps.isSuperseded(state.job)) {
    return finish(deps, state, "superseded");
  }
  const readiness = await checkReadiness(deps, state);
  if (readiness === "wait") {
    state = { ...state, readinessSince: state.readinessSince ?? startedAt };
    await deps.storage.put(STATE_KEY, state);
    await deps.storage.setAlarm(deps.now() + READINESS_RETRY_MS);
    return;
  }
  if (readiness === "timeout") {
    return finish(deps, state, "failed", "prerender_not_ready");
  }
  if (!state.reportedRunning) {
    await deps.lock.report(state.job, "running");
    state = { ...state, reportedRunning: true };
  }

  const total = unitCount(state.job);
  let checkedAt = startedAt;
  while (state.phase === "fill" && state.cursor < total) {
    const now = deps.now();
    if (now - startedAt >= WARM_ALARM_BUDGET_MS) return rearm(deps, state);
    if (!(await isCurrentJob(deps.storage, state.job.jobId))) return;
    if (now - checkedAt >= SUPERSEDE_CHECK_MS) {
      checkedAt = now;
      if (await deps.isSuperseded(state.job)) return finish(deps, state, "superseded");
    }
    if (state.reserved <= 0) {
      const wanted = Math.min(FILL_RESERVATION, total - state.cursor);
      const reservation = await deps.lock.reserveFills(state.job, wanted);
      if (reservation.status === "job_ended") return abandon(deps, state, "reserve");
      if (reservation.status === "budget_exhausted") {
        return rearm(deps, state, BUDGET_RETRY_MS, "budget");
      }
      state = { ...state, reserved: reservation.count };
    }
    const take = Math.min(WARM_FILL_CONCURRENCY, total - state.cursor, state.reserved);
    const units = range(state.cursor, take).map((index) => unitAt(state.job, index));
    const outcomes = await runLimited(units, WARM_FILL_CONCURRENCY, (unit) =>
      fillUnit(deps, state.job, unit),
    );
    state = {
      ...state,
      cursor: state.cursor + take,
      reserved: state.reserved - take,
      counts: addOutcomes(state.counts, outcomes),
    };
    await deps.storage.put(STATE_KEY, state);
  }

  if (state.phase === "fill") {
    // A run that used its budget verifies in the next alarm, so it stays
    // inside its 15-minute slot lease.
    if (deps.now() - startedAt >= WARM_ALARM_BUDGET_MS) return rearm(deps, state);
    const misses = await verifySample(deps, state.job, total);
    state = {
      ...state,
      counts: {
        ...state.counts,
        verified: state.counts.verified + misses.checked,
        verifyMisses: state.counts.verifyMisses + misses.indexes.length,
      },
    };
    if (misses.indexes.length === 0) return finish(deps, state, "done");
    // F38: the probe miss itself blocks stores of that key for a while.
    state = { ...state, phase: "refill", refill: misses.indexes };
    return rearm(deps, state, REFILL_DELAY_MS, "refill");
  }

  const refill = state.refill.map((index) => unitAt(state.job, index));
  const reservation = await deps.lock.reserveFills(state.job, refill.length);
  if (reservation.status === "job_ended") return abandon(deps, state, "reserve");
  // An exhausted budget skips the re-fill: the job still ends as done.
  const granted = reservation.status === "granted" ? reservation.count : 0;
  const outcomes = await runLimited(refill.slice(0, granted), WARM_FILL_CONCURRENCY, (unit) =>
    fillUnit(deps, state.job, unit),
  );
  state = {
    ...state,
    counts: {
      ...state.counts,
      refilled: state.counts.refilled + outcomes.filter((o) => o === "filled").length,
    },
  };
  return finish(deps, state, "done");
}

type Readiness = "ready" | "wait" | "timeout";

/** M36 sites: every hostname's saved output must be committed (F21). */
async function checkReadiness(deps: WarmerDeps, state: WarmerState): Promise<Readiness> {
  if (state.phase !== "fill" || state.cursor > 0) return "ready";
  const firstPage = state.job.pages[0];
  if (firstPage === undefined) return "ready";
  for (const target of state.job.targets) {
    const calls = await deps.selectCalls(target, firstPage);
    if (!calls?.saved) continue;
    if (await deps.isSavedOutputReady(calls.html)) continue;
    const since = state.readinessSince ?? deps.now();
    return deps.now() - since >= READINESS_MAX_WAIT_MS ? "timeout" : "wait";
  }
  return "ready";
}

async function fillUnit(deps: WarmerDeps, job: WarmJob, unit: WarmUnit): Promise<FillOutcome> {
  const call = await callOf(deps, job, unit);
  return call ? deps.fill(call) : "skipped";
}

/** Probes evenly spaced keys; returns the unit indexes that missed. */
async function verifySample(
  deps: WarmerDeps,
  job: WarmJob,
  total: number,
): Promise<{ checked: number; indexes: number[] }> {
  const indexes = sampleIndexes(total, VERIFY_SAMPLE_SIZE);
  const results = await runLimited(indexes, WARM_FILL_CONCURRENCY, async (index) => {
    const call = await callOf(deps, job, unitAt(job, index));
    if (!call) return { index, checked: false, stored: true };
    return { index, checked: true, stored: await deps.probe(call) };
  });
  return {
    checked: results.filter((result) => result.checked).length,
    indexes: results.filter((result) => !result.stored).map((result) => result.index),
  };
}

async function callOf(
  deps: WarmerDeps,
  job: WarmJob,
  unit: WarmUnit,
): Promise<PublicCacheCall | null> {
  const target = job.targets.find((candidate) => candidate.hostname === unit.hostname);
  if (!target) return null;
  const calls = await deps.selectCalls(target, unit.pathname);
  if (!calls) return null;
  return unit.representation === "html" ? calls.html : calls.data;
}

async function finish(
  deps: WarmerDeps,
  state: WarmerState,
  outcome: WarmOutcome,
  reason?: string,
): Promise<void> {
  // A newer job replaced this one during the run: it reports nothing.
  if (!(await isCurrentJob(deps.storage, state.job.jobId))) return;
  try {
    await deps.lock.report(state.job, outcome);
  } catch (error) {
    // A failed report counts as a failure, so a report that always throws
    // ends the warmer instead of waking it every minute forever. The report
    // phase counts from 0: earlier alarm errors do not shorten its 5 tries.
    const failures = (state.phase === "report" ? state.failures : 0) + 1;
    logWarm("docs_warm_region", {
      ...jobFacts(state.job, deps.holder),
      outcome: "report_failed",
      failures,
      error: describeWarmError(error),
    });
    if (failures >= MAX_ALARM_FAILURES) return abandon(deps, state, "report");
    // Keep the result and deliver it on the next alarm.
    await deps.storage.put(STATE_KEY, {
      ...state,
      phase: "report",
      finalOutcome: outcome,
      failures,
    } satisfies WarmerState);
    await deps.storage.setAlarm(deps.now() + FAILURE_RETRY_MS);
    return;
  }
  logWarm("docs_warm_region", {
    ...jobFacts(state.job, deps.holder),
    outcome,
    ...(reason ? { reason } : {}),
    pages: state.job.pages.length,
    hostnames: state.job.targets.length,
    ...state.counts,
    durationMs: deps.now() - state.job.startedAt,
  });
  await clearWarmer(deps.storage);
}

/**
 * The heartbeat. A lock that cannot be reached does not stop the warmer:
 * the lease is 30 minutes and the next alarm sends another one.
 */
async function sendHeartbeat(deps: WarmerDeps, state: WarmerState): Promise<boolean> {
  try {
    return await deps.lock.heartbeat(state.job);
  } catch (error) {
    logWarm("docs_warm_region", {
      ...jobFacts(state.job, deps.holder),
      outcome: "heartbeat_failed",
      error: describeWarmError(error),
    });
    return true;
  }
}

/**
 * Ends the job without a report and deletes this warmer's state: the site
 * lock ended the job (lease expiry, a newer job), or the report itself keeps
 * failing. A held slot is released by the caller.
 */
async function abandon(deps: WarmerDeps, state: WarmerState, step: string): Promise<void> {
  logWarm("docs_warm_region", {
    ...jobFacts(state.job, deps.holder),
    outcome: "job_ended",
    step,
    cursor: state.cursor,
    total: unitCount(state.job),
  });
  await clearWarmer(deps.storage);
}

async function rearm(
  deps: WarmerDeps,
  state: WarmerState,
  delayMs = 0,
  reason = "budget_time",
): Promise<void> {
  await deps.storage.put(STATE_KEY, state);
  await deps.storage.setAlarm(deps.now() + delayMs);
  logWarm("docs_warm_region", {
    ...jobFacts(state.job, deps.holder),
    outcome: "continued",
    reason,
    cursor: state.cursor,
    total: unitCount(state.job),
  });
}

async function isCurrentJob(
  storage: Pick<WarmStorage, "get">,
  jobId: string,
): Promise<boolean> {
  return (await readWarmerState(storage))?.job.jobId === jobId;
}

/** Writes only while `jobId` is still the stored job. */
function guardStorage(storage: WarmStorage, jobId: string): WarmStorage {
  const whileCurrent =
    <T>(write: () => Promise<T>, skipped: T) =>
    async (): Promise<T> =>
      (await isCurrentJob(storage, jobId)) ? write() : skipped;
  return {
    get: (key) => storage.get(key),
    getAlarm: () => storage.getAlarm(),
    put: (key, value) => whileCurrent(() => storage.put(key, value), undefined)(),
    delete: (key) => whileCurrent(() => storage.delete(key), false)(),
    deleteAll: () => whileCurrent(() => storage.deleteAll(), undefined)(),
    setAlarm: (time) => whileCurrent(() => storage.setAlarm(time), undefined)(),
    deleteAlarm: () => whileCurrent(() => storage.deleteAlarm(), undefined)(),
  };
}

export async function clearWarmer(storage: WarmStorage): Promise<void> {
  await storage.deleteAlarm();
  await storage.deleteAll();
}

function jobFacts(job: WarmJob, holder: string) {
  return {
    jobId: job.jobId,
    siteId: job.siteId,
    pool: job.pool,
    reason: job.reason,
    releaseId: job.releaseId,
    warmer: holder,
  };
}

/** 30 s after the first denial, then twice as long each time, at most 2 minutes. */
export function slotRetryDelay(slotWaits: number): number {
  return Math.min(SLOT_RETRY_MS * 2 ** Math.max(0, slotWaits - 1), SLOT_RETRY_MAX_MS);
}

/** The state with no slot waits: the key is left out, so a rolled-back deploy still reads it. */
function withoutSlotWaits(state: WarmerState): WarmerState {
  if (state.slotWaits === undefined) return state;
  const next = { ...state };
  delete next.slotWaits;
  return next;
}

/** Units are page-major: every hostname of the home page comes first. */
export function unitCount(job: WarmJob): number {
  return job.pages.length * job.targets.length * 2;
}

export function unitAt(job: WarmJob, index: number): WarmUnit {
  const perPage = job.targets.length * 2;
  const pathname = job.pages[Math.floor(index / perPage)] ?? "/";
  const rest = index % perPage;
  const target = job.targets[Math.floor(rest / 2)] ?? job.targets[0];
  return {
    hostname: target?.hostname ?? "",
    pathname,
    representation: rest % 2 === 0 ? "html" : "data",
  };
}

/** Up to `size` indexes spread evenly over `[0, total)`, the first included. */
export function sampleIndexes(total: number, size: number): number[] {
  if (total <= size) return range(0, total);
  const step = total / size;
  return [...new Set(range(0, size).map((i) => Math.floor(i * step)))];
}

function range(start: number, count: number): number[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => start + i);
}

function addOutcomes(counts: WarmCounts, outcomes: readonly FillOutcome[]): WarmCounts {
  const count = (outcome: FillOutcome) => outcomes.filter((o) => o === outcome).length;
  return {
    ...counts,
    filled: counts.filled + count("filled"),
    notFilled: counts.notFilled + count("not_filled"),
    errors: counts.errors + count("error"),
    skipped: counts.skipped + count("skipped"),
  };
}
