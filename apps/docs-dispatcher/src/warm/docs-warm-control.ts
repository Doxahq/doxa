import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import { isWarmSite, readWarmConfig } from "./warm-config";
import type { WarmControlRpc, WarmEnv } from "./warm-env";
import { WARM_SLOTS_NAME } from "./warm-job";
import { describeWarmError, logWarm } from "./warm-log";
import {
  DenialSampler,
  EMPTY_SLOT_STATE,
  acquireSlot,
  freeSlots,
  parseSlotState,
  releaseSlot,
  type SlotDecision,
  type SlotState,
} from "./warm-slots";
import {
  describeWarmRollout,
  parseSweepState,
  runSweepTick,
  sweepSiteCap,
} from "./warm-sweep";
import { readStored, type WarmStorage } from "./warm-storage";

/**
 * Two singletons of one class: `slots` holds the global warmer leases (F9)
 * and `sweep` holds the renderer-deploy sweep cursor. Each instance is one
 * Durable Object, so its calls never run at the same time.
 */

const SLOTS_KEY = "slots";
const SWEEP_KEY = "sweep";

const holderSchema = z.string().min(1).max(300);
const maxSchema = z.number().int().min(1).max(500);
const acquireInputSchema = z.object({
  holder: holderSchema,
  siteId: z.string().min(1).max(128),
  max: maxSchema,
  maxPerSite: maxSchema,
});

export class DocsWarmControl extends DurableObject<WarmEnv> implements WarmControlRpc {
  async acquireSlot(input: unknown): Promise<boolean> {
    const request = acquireInputSchema.parse(input);
    await this.slotsReady();
    const decision = acquireSlot(this.currentSlots(), { ...request, now: Date.now() });
    await this.saveSlots(decision.state);
    if (decision.expired > 0) {
      logWarm("docs_warm_slots", { action: "expired_takeover", expired: decision.expired });
    }
    this.logDecision(request, decision);
    return decision.granted;
  }

  async releaseSlot(input: unknown): Promise<void> {
    const { holder } = z.object({ holder: holderSchema }).parse(input);
    await this.slotsReady();
    const next = releaseSlot(this.currentSlots(), holder, Date.now());
    await this.saveSlots(next);
    logWarm("docs_warm_slots", { action: "release", holder, active: Object.keys(next.leases).length });
  }

  /** Every grant; only a sample of denials, with their count (FC-L10). */
  private readonly denials = new DenialSampler();

  private logDecision(
    request: { holder: string; siteId: string; max: number; maxPerSite: number },
    decision: SlotDecision,
  ): void {
    const fields = { action: "acquire", ...request, active: decision.active };
    if (decision.granted) {
      logWarm("docs_warm_slots", { ...fields, granted: true });
      return;
    }
    const denials = this.denials.record();
    if (denials === null) return;
    logWarm("docs_warm_slots", { ...fields, granted: false, reason: decision.denied, denials });
  }

  async freeSlots(input: unknown): Promise<number> {
    const { max } = z.object({ max: maxSchema }).parse(input);
    await this.slotsReady();
    return freeSlots(this.currentSlots(), max, Date.now());
  }

  /** One cron tick of the deploy sweep; only the `sweep` instance gets it. */
  async sweepTick(input: unknown): Promise<void> {
    const { releaseId } = z
      .object({ releaseId: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(input);
    const config = readWarmConfig(this.env);
    const store = this.env.DOCS_HOSTNAME_MAP;
    const queue = this.env.DOCS_WARM_SWEEP_QUEUE;
    const control = this.env.DOCS_WARM_CONTROL;
    if (!config.deploySweep || config.rollout.mode === "off" || !store || !queue || !control) {
      return;
    }
    const slots = control.get(control.idFromName(WARM_SLOTS_NAME));
    const free = await slots.freeSlots({ max: config.maxActiveWarmers });
    const startedAt = Date.now();
    const stored = await readStored(this.storage, SWEEP_KEY, parseSweepState);
    try {
      const result = await runSweepTick(
        stored,
        {
          releaseId,
          rollout: describeWarmRollout(config.rollout),
          cap: sweepSiteCap({
            sitesPerTick: config.sweepSitesPerTick,
            freeSlots: free,
            pools: config.pools.length,
          }),
        },
        {
          list: (options) => store.list(options),
          get: (key) => store.get(key),
          send: async (messages) => {
            await queue.sendBatch(messages.map((body) => ({ body })));
          },
          isWarmSite: (siteId) => isWarmSite(config, siteId),
          createJobId: () => crypto.randomUUID(),
          now: () => Date.now(),
        },
      );
      await this.storage.put(SWEEP_KEY, result.state);
      logWarm("docs_warm_sweep", {
        releaseId,
        rollout: result.state.rollout,
        reset: result.reset,
        enqueued: result.enqueued,
        total: result.state.enqueued,
        pages: result.pages,
        free,
        cursorDone: result.state.done,
        listMs: Date.now() - startedAt,
      });
    } catch (error) {
      logWarm("docs_warm_sweep", {
        releaseId,
        outcome: "failed",
        error: describeWarmError(error),
      });
      throw error;
    }
  }

  private get storage(): WarmStorage {
    return this.ctx.storage;
  }

  /**
   * The leases live in memory after the first read. Every decision reads
   * and replaces them with no await in between, so concurrent calls can
   * never grant more than `max` (F9).
   */
  private slots: SlotState | null = null;
  private slotsRead: Promise<void> | null = null;

  private slotsReady(): Promise<void> {
    this.slotsRead ??= readStored(this.storage, SLOTS_KEY, parseSlotState).then((stored) => {
      this.slots ??= stored ?? EMPTY_SLOT_STATE;
    });
    return this.slotsRead;
  }

  private currentSlots(): SlotState {
    return this.slots ?? EMPTY_SLOT_STATE;
  }

  /** Replaces the leases at once; the write follows. */
  private saveSlots(state: SlotState): Promise<void> {
    this.slots = state;
    return this.storage.put(SLOTS_KEY, state);
  }
}
