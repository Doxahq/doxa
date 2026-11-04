import {
  docsWarmMessageSchema,
  docsWarmPoolStateSchema,
  type DocsWarmMessage,
  type DocsWarmPoolState,
  type DocsWarmStatus,
} from "@doxahq/contracts/docs-warm-job";
import {
  DOCS_WARM_STATE_FORMAT,
  WARM_POOLS,
  docsWarmStateSchema,
  warmPoolSchema,
  type DocsWarmState,
  type WarmPool,
} from "@doxahq/contracts/docs-warm-state";
import { z } from "zod";

import { WARM_JOB_MAX_AGE_MS, type WarmOutcome } from "./warm-job";

/**
 * The state machine of one site's warm lock (`DocsWarmLock`). Pure: every
 * function takes the stored state and returns the next one, and the Durable
 * Object stores it and runs the effects. One running job per site; a newer
 * target waits as `pending` (newest wins) instead of a busy retry (F9). The
 * lock is the only writer of the site's warm state (spec § 6.2).
 */

/** A job that no warmer finished in this time ends; a pending job may start. */
export const WARM_LOCK_LEASE_MS = 30 * 60_000;
/**
 * A heartbeat renews the lease only when that adds at least this much: a
 * waiting warmer's frequent heartbeats then write at most once per 5 minutes,
 * and the lease never falls below 25 minutes.
 */
export const WARM_LOCK_RENEW_STEP_MS = 5 * 60_000;
/** A finished target is not warmed again for this long. */
export const WARM_DONE_RECORD_MS = 60 * 60_000;
const BUDGET_WINDOW_MS = 60 * 60_000;

const poolProgressSchema = z
  .object({
    state: docsWarmPoolStateSchema,
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

const runningJobSchema = z
  .object({
    jobId: z.string().uuid(),
    target: z.string().regex(/^[a-f0-9]{64}$/),
    releaseId: z.string().regex(/^[a-f0-9]{64}$/),
    startedAt: z.number().int().nonnegative(),
    leaseExpiresAt: z.number().int().nonnegative(),
    pools: z.partialRecord(warmPoolSchema, poolProgressSchema),
    superseded: z.boolean(),
  })
  .strict();

type RunningJob = z.infer<typeof runningJobSchema>;

const finishedJobSchema = z
  .object({
    releaseId: z.string().regex(/^[a-f0-9]{64}$/),
    startedAt: z.number().int().nonnegative(),
    finishedAt: z.number().int().nonnegative(),
    pools: z.partialRecord(warmPoolSchema, poolProgressSchema),
  })
  .strict();

export const warmLockStateSchema = z
  .object({
    siteId: z.string().min(1).max(128).nullable(),
    running: runningJobSchema.nullable(),
    pending: docsWarmMessageSchema.nullable(),
    /** Target hash → when a job for it finished. */
    done: z.record(z.string(), z.number().int().nonnegative()),
    last: finishedJobSchema.nullable(),
    budget: z
      .object({
        windowStart: z.number().int().nonnegative(),
        used: z.number().int().nonnegative(),
      })
      .strict(),
    /** The record this lock last wrote (or will write) to `warm:{siteId}`. */
    warmState: docsWarmStateSchema.nullable(),
    warmStateDirty: z.boolean(),
    /**
     * Failed writes of the dirty record since the last success: the retry
     * backs off and stops after `WARM_STATE_RETRY_MAX_MS`. Absent while no
     * write fails, so a rolled-back deploy (strict schema) still reads the
     * state.
     */
    warmStateRetry: z
      .object({
        attempts: z.number().int().positive(),
        firstFailedAt: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type WarmLockState = z.infer<typeof warmLockStateSchema>;

export const EMPTY_WARM_LOCK_STATE: WarmLockState = {
  siteId: null,
  running: null,
  pending: null,
  done: {},
  last: null,
  budget: { windowStart: 0, used: 0 },
  warmState: null,
  warmStateDirty: false,
};

export function parseWarmLockState(value: unknown): WarmLockState | null {
  const parsed = warmLockStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The state with no write retry: the key is left out, not set to empty. */
export function withoutWarmStateRetry(state: WarmLockState): WarmLockState {
  if (state.warmStateRetry === undefined) return state;
  const next = { ...state };
  delete next.warmStateRetry;
  return next;
}

export type SubmitOutcome =
  /** The job runs now; the consumer starts the pools. */
  | "granted"
  /** The same job runs already (a message retry): start the pools again. */
  | "continued"
  /** Another job runs the same target: nothing to do. */
  | "duplicate"
  /** The same target finished less than an hour ago: nothing to do. */
  | "done_recently"
  /** Another job runs: this message waits, newest wins. */
  | "pending"
  /** An older pending message was newer than this one: dropped. */
  | "stale";

export interface WarmLockEffects {
  /** Write `warmState` to the hostname map namespace (debounced). */
  flushWarmState: boolean;
  /** A message to send to the publish queue: the pending job starts. */
  startPending: DocsWarmMessage | null;
  /** A job ended: its facts for `docs_warm_lock`. */
  finished: { jobId: string; reason: "completed" | "superseded" | "expired" } | null;
}

const NO_EFFECTS: WarmLockEffects = {
  flushWarmState: false,
  startPending: null,
  finished: null,
};

export interface LockTransition<T> {
  state: WarmLockState;
  result: T;
  effects: WarmLockEffects;
}

export function submitWarmJob(
  current: WarmLockState,
  input: {
    message: DocsWarmMessage;
    target: string;
    pools: readonly WarmPool[];
    now: number;
  },
): LockTransition<{ outcome: SubmitOutcome; tookOver: boolean }> {
  const { message, target, now } = input;
  const expired = expireLease(current, now);
  const state = pruneDone({ ...expired.state, siteId: message.siteId }, now);
  const running = state.running;
  const tookOver = expired.effects.finished !== null;
  const done = (outcome: SubmitOutcome, next: WarmLockState = state) => ({
    state: next,
    result: { outcome, tookOver },
    effects: expired.effects,
  });

  if (running?.jobId === message.jobId) return done("continued");
  if (running?.target === target) return done("duplicate");
  const doneAt = state.done[target];
  if (!running && doneAt !== undefined && doneAt >= now - WARM_DONE_RECORD_MS) {
    return done("done_recently");
  }
  if (running) {
    if (state.pending && state.pending.enqueuedAt > message.enqueuedAt) {
      return done("stale");
    }
    return done("pending", { ...state, pending: message });
  }
  // Nothing runs. A waiting message (the one an expired lease just released,
  // or one whose send failed) that is newer than this one wins: it starts
  // and this one is dropped. Otherwise this one runs and the older is
  // dropped (FC-L5).
  const waiting = expired.effects.startPending ?? state.pending;
  if (waiting && isNewer(waiting, message)) {
    return {
      state: { ...state, pending: waiting },
      result: { outcome: "stale", tookOver },
      effects: { ...expired.effects, startPending: waiting },
    };
  }
  return {
    state: { ...state, pending: null, running: grantedJob(message, target, input.pools, now) },
    result: { outcome: "granted", tookOver },
    // This message runs now; an older waiting one is dropped.
    effects: { ...expired.effects, startPending: null },
  };
}

/** Newest wins; a tie keeps the incoming message. */
function isNewer(waiting: DocsWarmMessage, incoming: DocsWarmMessage): boolean {
  return waiting.jobId !== incoming.jobId && waiting.enqueuedAt > incoming.enqueuedAt;
}

function grantedJob(
  message: DocsWarmMessage,
  target: string,
  pools: readonly WarmPool[],
  now: number,
): RunningJob {
  return {
    jobId: message.jobId,
    target,
    releaseId: message.releaseId,
    startedAt: now,
    leaseExpiresAt: now + WARM_LOCK_LEASE_MS,
    pools: Object.fromEntries(
      pools.map((pool) => [pool, { state: "pending" as const, updatedAt: now }]),
    ),
    superseded: false,
  };
}

export type PoolReport = "running" | WarmOutcome;

/**
 * A warmer's progress. Only the running job's reports count. A `done` pool
 * of the deployed release goes into the warm state; a new release replaces
 * the record.
 */
export function reportWarmPool(
  current: WarmLockState,
  input: {
    jobId: string;
    pool: WarmPool;
    report: PoolReport;
    deployedReleaseId: string | null;
    now: number;
  },
): LockTransition<{ accepted: boolean }> {
  const { now } = input;
  const running = current.running;
  if (!running || running.jobId !== input.jobId) {
    return { state: current, result: { accepted: false }, effects: NO_EFFECTS };
  }
  const poolState: DocsWarmPoolState =
    input.report === "superseded" ? "failed" : input.report;
  const nextRunning: RunningJob = {
    ...running,
    pools: { ...running.pools, [input.pool]: { state: poolState, updatedAt: now } },
    superseded: running.superseded || input.report === "superseded",
  };
  let state: WarmLockState = { ...current, running: nextRunning };
  let flushWarmState = false;
  if (
    input.report === "done" &&
    input.deployedReleaseId !== null &&
    running.releaseId === input.deployedReleaseId
  ) {
    state = {
      ...state,
      warmState: withPoolDone(state.warmState, running.releaseId, input.pool, now),
      warmStateDirty: true,
    };
    flushWarmState = true;
  }
  if (!allPoolsEnded(nextRunning)) {
    return {
      state,
      result: { accepted: true },
      effects: { ...NO_EFFECTS, flushWarmState },
    };
  }
  const finished = finishJob(
    state,
    nextRunning.superseded ? "superseded" : "completed",
    now,
  );
  return {
    state: finished.state,
    result: { accepted: true },
    effects: { ...finished.effects, flushWarmState },
  };
}

/** Ends a running job whose lease ran out; the pending job may start. */
export function expireLease(
  current: WarmLockState,
  now: number,
): LockTransition<null> {
  if (!current.running || current.running.leaseExpiresAt > now) {
    return { state: current, result: null, effects: NO_EFFECTS };
  }
  const running = current.running;
  const pools = Object.fromEntries(
    Object.entries(running.pools).map(([pool, progress]) => [
      pool,
      progress.state === "done"
        ? progress
        : { state: "failed" as const, updatedAt: now },
    ]),
  );
  const finished = finishJob(
    { ...current, running: { ...running, pools } },
    "expired",
    now,
  );
  return { state: finished.state, result: null, effects: finished.effects };
}

/**
 * The lease end after a sign of life: 30 minutes on, never past the job's
 * maximum age, so a stuck job still ends (FC-H2).
 */
/** No lease runs past 3 h after the job started. */
function leaseCap(job: RunningJob): number {
  return job.startedAt + WARM_JOB_MAX_AGE_MS;
}

function renewedLease(job: RunningJob, now: number): number {
  return Math.min(now + WARM_LOCK_LEASE_MS, leaseCap(job));
}

/**
 * A warmer's heartbeat, sent on every alarm run, also while it waits for a
 * slot or for saved output: it keeps the lease of a job that is still the
 * current one. An ended lease ends the job first.
 */
export function heartbeatWarmJob(
  current: WarmLockState,
  input: { jobId: string; now: number },
): LockTransition<{ current: boolean }> {
  // A waiting warmer sends a heartbeat on every alarm. Most of them leave
  // the state as it is, which saves the storage write.
  return keepLease(current, input, WARM_LOCK_RENEW_STEP_MS);
}

/**
 * Ends an expired lease, then renews the job's lease when that adds at
 * least `minStepMs`, or when it reaches the 3-hour cap: near the cap every
 * renewal is smaller, so the lease would otherwise end before it. A lease at
 * the cap does not change.
 */
function keepLease(
  current: WarmLockState,
  input: { jobId: string; now: number },
  minStepMs: number,
): LockTransition<{ current: boolean }> {
  const expired = expireLease(current, input.now);
  const running = expired.state.running;
  if (running?.jobId !== input.jobId) {
    return { state: expired.state, result: { current: false }, effects: expired.effects };
  }
  const leaseExpiresAt = renewedLease(running, input.now);
  const step = leaseExpiresAt - running.leaseExpiresAt;
  if (step <= 0 || (step < minStepMs && leaseExpiresAt < leaseCap(running))) {
    return { state: expired.state, result: { current: true }, effects: expired.effects };
  }
  return {
    state: { ...expired.state, running: { ...running, leaseExpiresAt } },
    result: { current: true },
    effects: expired.effects,
  };
}

export type FillReservation =
  | { status: "granted"; count: number }
  /** The hourly budget is used up: retry at `retryAt`. */
  | { status: "budget_exhausted"; retryAt: number }
  /** The job is not the running one any more: the warmer stops. */
  | { status: "job_ended" };

/**
 * Takes up to `count` fills from the site's hourly budget. A warmer that
 * gets fewer than it asked for waits for the next window. A reservation
 * always renews the lease: it writes the budget anyway.
 */
export function reserveWarmFills(
  current: WarmLockState,
  input: { jobId: string; count: number; perHour: number; now: number },
): LockTransition<FillReservation> {
  const beat = keepLease(current, input, 0);
  if (!beat.result.current) {
    return { state: beat.state, result: { status: "job_ended" }, effects: beat.effects };
  }
  const windowStart = input.now - (input.now % BUDGET_WINDOW_MS);
  const used =
    beat.state.budget.windowStart === windowStart ? beat.state.budget.used : 0;
  const granted = Math.max(0, Math.min(input.count, input.perHour - used));
  return {
    state: { ...beat.state, budget: { windowStart, used: used + granted } },
    result:
      granted > 0 || input.count === 0
        ? { status: "granted", count: granted }
        : { status: "budget_exhausted", retryAt: nextBudgetWindow(input.now) },
    effects: beat.effects,
  };
}

/** The start of the next budget window, for a warmer that ran out. */
export function nextBudgetWindow(now: number): number {
  return now - (now % BUDGET_WINDOW_MS) + BUDGET_WINDOW_MS;
}

/** `getWarmStatus`: the running job, else the last one of the past hour. */
export function describeWarmStatus(
  state: WarmLockState,
  siteId: string,
  now: number,
): DocsWarmStatus {
  const job =
    state.running ??
    (state.last && state.last.finishedAt >= now - WARM_DONE_RECORD_MS
      ? state.last
      : null);
  if (!job) {
    return { siteId, releaseId: null, startedAt: null, finishedAt: null, pools: [] };
  }
  return {
    siteId,
    releaseId: job.releaseId,
    startedAt: job.startedAt,
    finishedAt: "finishedAt" in job ? job.finishedAt : null,
    pools: WARM_POOLS.flatMap((pool) => {
      const progress = job.pools[pool];
      return progress ? [{ pool, ...progress }] : [];
    }),
  };
}

function finishJob(
  current: WarmLockState,
  reason: "completed" | "superseded" | "expired",
  now: number,
): { state: WarmLockState; effects: WarmLockEffects } {
  const running = current.running;
  if (!running) return { state: current, effects: NO_EFFECTS };
  const done =
    reason === "completed"
      ? { ...current.done, [running.target]: now }
      : current.done;
  return {
    state: {
      ...current,
      running: null,
      pending: null,
      done,
      last: {
        releaseId: running.releaseId,
        startedAt: running.startedAt,
        finishedAt: now,
        pools: running.pools,
      },
    },
    effects: {
      flushWarmState: false,
      startPending: current.pending,
      finished: { jobId: running.jobId, reason },
    },
  };
}

function allPoolsEnded(job: RunningJob): boolean {
  return Object.values(job.pools).every(
    (progress) => progress.state === "done" || progress.state === "failed",
  );
}

function withPoolDone(
  record: DocsWarmState | null,
  releaseId: string,
  pool: WarmPool,
  now: number,
): DocsWarmState {
  const pools = record?.releaseId === releaseId ? record.pools : {};
  return docsWarmStateSchema.parse({
    format: DOCS_WARM_STATE_FORMAT,
    releaseId,
    pools: { ...pools, [pool]: now },
  });
}

function pruneDone(state: WarmLockState, now: number): WarmLockState {
  const done = Object.fromEntries(
    Object.entries(state.done).filter(
      ([, finishedAt]) => finishedAt >= now - WARM_DONE_RECORD_MS,
    ),
  );
  return { ...state, done };
}
