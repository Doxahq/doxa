import {
  docsWarmMessageSchema,
  type DocsWarmStatus,
} from "@doxahq/contracts/docs-warm-job";
import { docsWarmStateKey, warmPoolSchema } from "@doxahq/contracts/docs-warm-state";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import { readWarmConfig } from "./warm-config";
import type { WarmEnv, WarmLockRpc } from "./warm-env";
import { warmOutcomeSchema } from "./warm-job";
import {
  EMPTY_WARM_LOCK_STATE,
  describeWarmStatus,
  expireLease,
  heartbeatWarmJob,
  parseWarmLockState,
  reportWarmPool,
  reserveWarmFills,
  submitWarmJob,
  type FillReservation,
  type LockTransition,
  type SubmitOutcome,
  type WarmLockState,
} from "./warm-lock-state";
import { describeWarmError, logWarm } from "./warm-log";
import { readStored, type WarmStorage } from "./warm-storage";

/**
 * One per site (`idFromName("site:" + siteId)`): the running warm job, the
 * pending target, per-pool progress, the done record, the hourly fill budget
 * and the only writer of `warm:{siteId}` (spec § 6.2, § 7.1). The rules live
 * in warm-lock-state.ts; this class stores the state and runs the effects.
 */

const STATE_KEY = "state";
/** KV allows one write per second per key: pool reports are batched. */
const FLUSH_DELAY_MS = 1_000;
const RETRY_DELAY_MS = 60_000;
/** The warm-state record outlives any build window (M26 reads it ≤ 7 days). */
const WARM_STATE_TTL_SECONDS = 30 * 86_400;

const siteIdSchema = z.string().min(1).max(128);
const targetSchema = z.string().regex(/^[a-f0-9]{64}$/);

const submitInputSchema = z.object({
  message: docsWarmMessageSchema,
  target: targetSchema,
  pools: z.array(warmPoolSchema).min(1).max(8),
});

const reportInputSchema = z.object({
  siteId: siteIdSchema,
  jobId: z.string().uuid(),
  pool: warmPoolSchema,
  report: z.union([z.literal("running"), warmOutcomeSchema]),
});

const heartbeatInputSchema = z.object({
  siteId: siteIdSchema,
  jobId: z.string().uuid(),
});

const reserveInputSchema = z.object({
  siteId: siteIdSchema,
  jobId: z.string().uuid(),
  count: z.number().int().min(0).max(1_000),
});

export class DocsWarmLock extends DurableObject<WarmEnv> implements WarmLockRpc {
  async submit(input: unknown): Promise<{ outcome: SubmitOutcome }> {
    const { message, target, pools } = submitInputSchema.parse(input);
    const result = await this.apply((state) =>
      submitWarmJob(state, { message, target, pools, now: Date.now() }),
    );
    logWarm("docs_warm_lock", {
      siteId: message.siteId,
      jobId: message.jobId,
      action: "submit",
      state: result.outcome,
      tookOver: result.tookOver,
    });
    return { outcome: result.outcome };
  }

  async report(input: unknown): Promise<void> {
    const { jobId, pool, report } = reportInputSchema.parse(input);
    const deployedReleaseId = this.env.DOXA_RENDERER_RELEASE_ID?.trim() || null;
    const result = await this.apply((state) =>
      reportWarmPool(state, { jobId, pool, report, deployedReleaseId, now: Date.now() }),
    );
    if (!result.accepted) {
      logWarm("docs_warm_lock", { jobId, pool, action: "report", state: "ignored", report });
    }
  }

  /** Keeps the job's lease; `current: false` tells the warmer to stop. */
  async heartbeat(input: unknown): Promise<{ current: boolean }> {
    const { jobId } = heartbeatInputSchema.parse(input);
    return this.apply((state) => heartbeatWarmJob(state, { jobId, now: Date.now() }));
  }

  async reserveFills(input: unknown): Promise<FillReservation> {
    const { jobId, count } = reserveInputSchema.parse(input);
    const perHour = readWarmConfig(this.env).siteFillsPerHour;
    return this.apply((state) =>
      reserveWarmFills(state, { jobId, count, perHour, now: Date.now() }),
    );
  }

  async getStatus(input: unknown): Promise<DocsWarmStatus> {
    const { siteId } = z.object({ siteId: siteIdSchema }).parse(input);
    return describeWarmStatus(await this.load(), siteId, Date.now());
  }

  /**
   * Writes the warm state, ends an expired lease, resends a pending job.
   * Inside this handler the next alarm is set directly from the state, never
   * through the keep-the-earliest read (FC-A): Cloudflare documents that
   * `getAlarm()` inside `alarm()` "returns null unless setAlarm has also been
   * called since the alarm handler started running"
   * (https://developers.cloudflare.com/durable-objects/api/alarms/), so the
   * read is safe today, but the re-arm must not depend on it.
   */
  async alarm(): Promise<void> {
    this.alarmWanted = Number.POSITIVE_INFINITY;
    this.inAlarm = true;
    try {
      await this.apply((state) => expireLease(state, Date.now()));
      const state = await this.load();
      if (state.warmStateDirty) await this.flushWarmState(state);
      const latest = await this.load();
      if (latest.pending && !latest.running) await this.startPending(latest);
    } finally {
      this.inAlarm = false;
      const next = Math.min(this.alarmWanted, nextLockAlarm(this.current(), Date.now()));
      if (Number.isFinite(next)) await this.storage.setAlarm(next);
    }
  }

  /** While `alarm()` runs, wanted alarm times collect here (FC-A). */
  private inAlarm = false;
  private alarmWanted = Number.POSITIVE_INFINITY;

  private get storage(): WarmStorage {
    return this.ctx.storage;
  }

  /**
   * The state lives in memory after the first read. A transition reads and
   * replaces it without an await in between, so concurrent calls never
   * work on the same old state.
   */
  private cached: WarmLockState | null = null;
  private firstRead: Promise<void> | null = null;

  private ready(): Promise<void> {
    this.firstRead ??= readStored(this.storage, STATE_KEY, parseWarmLockState).then((stored) => {
      this.cached ??= stored ?? EMPTY_WARM_LOCK_STATE;
    });
    return this.firstRead;
  }

  private current(): WarmLockState {
    return this.cached ?? EMPTY_WARM_LOCK_STATE;
  }

  private async load(): Promise<WarmLockState> {
    await this.ready();
    return this.current();
  }

  /** Replaces the state at once; the write follows. */
  private save(state: WarmLockState): Promise<void> {
    this.cached = state;
    return this.storage.put(STATE_KEY, state);
  }

  private async apply<T>(
    transition: (state: WarmLockState) => LockTransition<T>,
  ): Promise<T> {
    await this.ready();
    const next = transition(this.current());
    await this.save(next.state);
    const { effects } = next;
    if (effects.finished) {
      logWarm("docs_warm_lock", {
        siteId: next.state.siteId,
        jobId: effects.finished.jobId,
        action: "finish",
        state: effects.finished.reason,
      });
    }
    if (effects.flushWarmState) await this.scheduleAlarm(Date.now() + FLUSH_DELAY_MS);
    if (effects.startPending) await this.startPending(next.state, effects.startPending);
    await this.scheduleLeaseCheck(next.state);
    return next.result;
  }

  private async flushWarmState(state: WarmLockState): Promise<void> {
    const store = this.env.DOCS_HOSTNAME_MAP;
    if (!state.siteId || !state.warmState || !store) return;
    try {
      await store.put(docsWarmStateKey(state.siteId), JSON.stringify(state.warmState), {
        expirationTtl: WARM_STATE_TTL_SECONDS,
      });
      // A report that arrived during the write keeps the record dirty.
      const latest = this.current();
      if (latest.warmState && JSON.stringify(latest.warmState) === JSON.stringify(state.warmState)) {
        await this.save({ ...latest, warmStateDirty: false });
      }
      logWarm("docs_warm_lock", {
        siteId: state.siteId,
        action: "warm_state_written",
        releaseId: state.warmState.releaseId,
        pools: Object.keys(state.warmState.pools),
      });
    } catch (error) {
      logWarm("docs_warm_lock", {
        siteId: state.siteId,
        action: "warm_state_write_failed",
        error: describeWarmError(error),
      });
      await this.scheduleAlarm(Date.now() + FLUSH_DELAY_MS * 5);
    }
  }

  /** Sends the pending message to the publish queue; it keeps it on failure. */
  private async startPending(
    state: WarmLockState,
    message = state.pending,
  ): Promise<void> {
    if (!message) return;
    const queue = this.env.DOCS_WARM_PUBLISH_QUEUE;
    try {
      if (!queue) throw new Error("DOCS_WARM_PUBLISH_QUEUE is not bound");
      await queue.send(message);
      const latest = this.current();
      if (latest.pending?.jobId === message.jobId) {
        await this.save({ ...latest, pending: null });
      }
      logWarm("docs_warm_lock", {
        siteId: message.siteId,
        jobId: message.jobId,
        action: "start_pending",
        state: "sent",
      });
    } catch (error) {
      const latest = this.current();
      if (!latest.pending) await this.save({ ...latest, pending: message });
      logWarm("docs_warm_lock", {
        siteId: message.siteId,
        jobId: message.jobId,
        action: "start_pending",
        state: "failed",
        error: describeWarmError(error),
      });
      await this.scheduleAlarm(Date.now() + RETRY_DELAY_MS);
    }
  }

  private async scheduleLeaseCheck(state: WarmLockState): Promise<void> {
    if (state.running) await this.scheduleAlarm(state.running.leaseExpiresAt);
  }

  /** Keeps the earliest alarm; inside `alarm()` the handler sets it at the end. */
  private async scheduleAlarm(time: number): Promise<void> {
    if (this.inAlarm) {
      this.alarmWanted = Math.min(this.alarmWanted, time);
      return;
    }
    const current = await this.storage.getAlarm();
    if (current === null || current > time) await this.storage.setAlarm(time);
  }
}

/**
 * The alarm the state still needs after an alarm run: a retry of an unwritten
 * warm state, a resend of a pending message, the running job's lease end.
 */
export function nextLockAlarm(state: WarmLockState, now: number): number {
  const times = [
    state.warmStateDirty ? now + FLUSH_DELAY_MS * 5 : Number.POSITIVE_INFINITY,
    state.pending && !state.running ? now + RETRY_DELAY_MS : Number.POSITIVE_INFINITY,
    state.running ? state.running.leaseExpiresAt : Number.POSITIVE_INFINITY,
  ];
  return Math.min(...times);
}
