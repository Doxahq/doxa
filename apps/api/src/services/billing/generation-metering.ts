import {
  BillingNotFoundError,
  BillingStateError,
  CreditsExhaustedError,
  DAY_MS,
  ESTIMATE_HISTORY_RUNS,
  PlanLimitError,
  RESERVATION_IN_USE,
  chargeCredits,
  chargeRuleFor,
  creditNotifications,
  estimateRun,
  firstHoldCredits,
  formatUsd12,
  hasFeature,
  meterPricingFor,
  parseUsd,
  readCreditSnapshot,
  resolveCap,
  withProjectedDebit,
  startOfUtcDay,
  usageCredits,
  type AccountBillingView,
  type BillingEnforcement,
  type BillingNotification,
  type BillingNotifier,
  type CreditContext,
  type FeatureKey,
} from "@doxahq/billing";
import {
  DEFAULT_MODEL_PROVIDER,
  modelProviderSchema,
  type GenerationJobDto,
  type GenerationStopReason,
  type ModelProvider,
} from "@doxahq/contracts";
import { isModelPriced } from "@doxahq/contracts/model-prices";
import {
  GENERATION_CREDITS_EVENT_INTERVAL_MS,
  type GenerationCreditsEventData,
} from "@doxahq/contracts/billing";
import type { BillingCore } from "./core";

/**
 * The credit meter of generation, Doxabot and merge runs (billing spec 10.5,
 * phase 5): open at admission, accrue after each usage record, a stop reason
 * for `isJobActive`, settle at the job end, and the cron sweep of holds whose
 * job ended.
 *
 * `BILLING_ENFORCEMENT`:
 * - `off`: no meter call at all. Every method returns at once, and nothing
 *   reads or writes the billing tables, so jobs run exactly as before billing.
 * - `shadow`: admission computes each refusal (feature, unpriced model, cost
 *   guard, the first hold against the balance) and logs it; the settle
 *   computes the price of the run from its usage records and logs it. No
 *   reservation, no debit, no stop. A billing error is logged, never thrown.
 * - `on`: real holds, accruals, stops, debits and refusals.
 */

/** The metered AI actions of a generation job. Decision D7: a production run after merges is a `doxabot.run`. */
export type MeteredAction = "generation.run" | "doxabot.run";

const METERED_ACTIONS: ReadonlySet<string> = new Set<MeteredAction>(["generation.run", "doxabot.run"]);

export function isMeteredAction(value: string): value is MeteredAction {
  return METERED_ACTIONS.has(value);
}

/** The end of a run, before it maps to the charge rule key of its action. */
export type RunOutcome = "succeeded" | "pages_changed" | "no_change" | "superseded" | "stopped" | "cancelled" | "failed";

/** What decides the action of a run: who started it, and whether it starts from a baseline. */
export interface MeteredJobShape {
  readonly publicationMode: "production" | "preview";
  readonly trigger: string;
  /** The baseline (generation cache) of the run; null for a cold run. */
  readonly baselineVersionId: string | null;
}

/** True for a run that Doxabot starts: a pull request preview, or a production run after merges. */
function isDoxabotRun(job: Pick<MeteredJobShape, "publicationMode" | "trigger">): boolean {
  return job.publicationMode === "preview" || job.trigger === "merge";
}

/**
 * The action of a run. A Doxabot run with a baseline (warm) is a
 * `doxabot.run`. A Doxabot run without one (cold: the first run, after Clear
 * cache, or no compatible published state) analyzes the whole repository like
 * a full generation, so it is a `generation.run`. A run that a person starts
 * is always a `generation.run`.
 */
export function meteredActionOf(job: MeteredJobShape): MeteredAction {
  return isDoxabotRun(job) && job.baselineVersionId !== null ? "doxabot.run" : "generation.run";
}

const FEATURE_OF: Record<MeteredAction, FeatureKey> = {
  "generation.run": "ai.doxa_agent",
  "doxabot.run": "ai.doxabot",
};

/**
 * The plan features a run needs, in the order they are checked. A Doxabot
 * run needs `ai.doxabot` whatever its action, and a cold one also needs the
 * feature of `generation.run`, because it is metered as one.
 */
export function requiredFeaturesOf(
  job: MeteredJobShape,
  action: MeteredAction = meteredActionOf(job),
): readonly FeatureKey[] {
  const feature = FEATURE_OF[action];
  if (!isDoxabotRun(job) || feature === "ai.doxabot") return [feature];
  return ["ai.doxabot", feature];
}

/** The charge rule key of an outcome (catalog `charge` of each action). */
export function chargeOutcomeFor(action: MeteredAction, outcome: RunOutcome): string {
  if (action === "generation.run") {
    if (outcome === "pages_changed" || outcome === "no_change") return "succeeded";
    if (outcome === "superseded") return "cancelled";
    return outcome;
  }
  return outcome === "succeeded" ? "pages_changed" : outcome;
}

/** A refusal that is neither a plan limit nor a credit balance (billing spec 10.5 step 7, 19). */
export class AiAdmissionError extends Error {
  override readonly name = "AiAdmissionError";
  constructor(
    readonly code: "model_unpriced" | "ai_paused_for_review",
    message: string,
    readonly details: { readonly accountId?: string; readonly models?: readonly string[]; readonly resetsAt?: Date | null },
  ) {
    super(message);
  }
}

export type BillingRefusal = CreditsExhaustedError | PlanLimitError | AiAdmissionError;

export function isBillingRefusal(cause: unknown): cause is BillingRefusal {
  return cause instanceof CreditsExhaustedError || cause instanceof PlanLimitError || cause instanceof AiAdmissionError;
}

export interface MeteringRun {
  readonly jobId: string;
  readonly projectId: string;
  readonly action: MeteredAction;
  /** The planner, writer and fallback writer models of the run. */
  readonly models: readonly string[];
  /**
   * The plan features the run needs, checked in order (`requiredFeaturesOf`).
   * Default: the feature of `action`.
   */
  readonly features?: readonly FeatureKey[];
  /**
   * A continued run keeps its job ID, so its new hold needs its own key
   * (spec 10.5: a continue is a new admission with a new reservation).
   */
  readonly attempt?: string;
}

export type MeterAdmission =
  | {
      readonly kind: "admitted";
      /** True when the meter holds credits for the run (`on`). */
      readonly metered: boolean;
      readonly capCredits: number | null;
      /** The hold that this admission opened, for `abandon`. Null when the meter holds nothing. */
      readonly reservationId: string | null;
    }
  | { readonly kind: "refused"; readonly error: BillingRefusal }
  /** Another admission of the job still holds credits (`RESERVATION_IN_USE`): a second continue. */
  | { readonly kind: "busy" };

/** What the settle and the sweep read about a job. */
export interface MeteringJobFacts {
  readonly projectId: string;
  readonly status: GenerationJobDto["status"];
  readonly publicationMode: "production" | "preview";
  readonly trigger: string;
  /** The baseline of the run (`generation_jobs.baseline_version_id`); null for a cold run. */
  readonly baselineVersionId: string | null;
  /** The type and data of the job's last terminal event, or null. */
  readonly terminalEvent: { readonly type: string; readonly data: Readonly<Record<string, unknown>> | null } | null;
}

export interface MeteringJobsPort {
  getFacts(jobId: string): Promise<MeteringJobFacts | null>;
  /** The sum of `cost_usd` of the job's usage records (shadow settle). */
  usageCostUsd(jobId: string): Promise<string | null>;
  /** Job IDs of the project, newest first (the estimate). */
  recentJobIds(projectId: string, limit: number): Promise<string[]>;
  /** The live credit meter event (billing spec 10.5, "What the customer sees"). */
  addCreditsEvent?(jobId: string, data: GenerationCreditsEventData): Promise<void>;
  /**
   * The job's usage records since `since` that have no accrual row: the
   * accrual after the insert failed (billing spec 10.5 step 2). The settle
   * and the sweep accrue them before they charge.
   */
  unaccruedUsage(jobId: string, since: Date): Promise<readonly { callId: string; costUsd: string | null }[]>;
}

/** Billing spec 19: the model cost of an account's projects since a time. */
export interface DailyModelCostPort {
  modelCostUsdSince(input: { ownerKind: "user" | "team"; ownerId: string; since: Date }): Promise<string | null>;
}

export type MeteringLog = (event: string, fields: Readonly<Record<string, string | number | boolean | null>>) => void;

export interface GenerationMeteringDeps {
  readonly mode: BillingEnforcement;
  /** Built on first use, so `off` never builds it. */
  readonly core: () => BillingCore;
  readonly jobs: MeteringJobsPort;
  readonly costs?: DailyModelCostPort;
  readonly modelProvider?: ModelProvider;
  readonly log?: MeteringLog;
  /** At most one live credits event for each job in this window. */
  readonly creditsEventIntervalMs?: number;
  /**
   * The billing emails (spec 10.7). The notifier follows the same
   * `BILLING_ENFORCEMENT`: `shadow` logs what it would send.
   */
  readonly notifier?: BillingNotifier;
}

const TERMINAL: ReadonlySet<GenerationJobDto["status"]> = new Set(["succeeded", "failed", "cancelled", "stopped_credits"]);
const SWEEP_BATCH = 200;
const ORPHAN_HOLD_MS = DAY_MS;
const CREDITS_EVENT_INTERVAL_MS = GENERATION_CREDITS_EVENT_INTERVAL_MS;
/** Job ID -> time of its last live credits event, for this process. */
const lastCreditsEvent = new Map<string, number>();

export const consoleMeteringLog: MeteringLog = (event, fields) => {
  console.log(JSON.stringify({ service: "doxa-api", event, ...fields }));
};

export class GenerationMetering {
  readonly mode: BillingEnforcement;
  private built: BillingCore | null = null;

  constructor(private readonly deps: GenerationMeteringDeps) {
    this.mode = deps.mode;
  }

  private get core(): BillingCore {
    return (this.built ??= this.deps.core());
  }

  private log(event: string, fields: Readonly<Record<string, string | number | boolean | null>>): void {
    (this.deps.log ?? consoleMeteringLog)(event, { mode: this.mode, ...fields });
  }

  /**
   * Billing spec 10.5 step 1. `on` holds the first credits for the run or
   * refuses it; `shadow` logs what `on` would do and always admits.
   */
  async admit(run: MeteringRun): Promise<MeterAdmission> {
    if (this.mode === "off") return { kind: "admitted", metered: false, capCredits: null, reservationId: null };
    if (this.mode === "shadow") {
      try {
        await this.shadowAdmit(run);
      } catch (cause) {
        this.logFailure("admit", run.jobId, cause);
      }
      return { kind: "admitted", metered: false, capCredits: null, reservationId: null };
    }
    let view: AccountBillingView | null = null;
    try {
      view = await this.core.entitlements.forProject(run.projectId);
      await this.checkBeforeHold(run, view);
      const estimateCredits = await this.estimateCredits(run, view);
      const opened = await this.core.meter.open({
        accountId: view.account.id,
        actionKey: run.action,
        subject: { kind: "job", id: run.jobId },
        estimateCredits,
        ...(run.attempt ? { idempotencyKey: `job:${run.jobId}:reserve:${run.attempt}` } : {}),
      });
      if (opened.kind === "not_metered") return { kind: "admitted", metered: false, capCredits: null, reservationId: null };
      return { kind: "admitted", metered: true, capCredits: opened.capCredits, reservationId: opened.reservation.id };
    } catch (cause) {
      if (cause instanceof BillingStateError && cause.code === RESERVATION_IN_USE) return { kind: "busy" };
      if (isBillingRefusal(cause)) {
        this.logRefusal(run, cause);
        if (view && cause instanceof CreditsExhaustedError && cause.details.reason === "trial_credits") {
          await this.notifyTrialExhausted(view.account.id, view.creditContext, run.jobId);
        }
        return { kind: "refused", error: cause };
      }
      throw cause;
    }
  }

  /**
   * The admission did not create or reopen the job (another run was active,
   * or another continue won): free the hold that this admission opened, and
   * no other. Two continues of one job can race: the newest hold can belong
   * to the continue that won, and the job runs on it.
   */
  async abandon(jobId: string, admission: MeterAdmission): Promise<void> {
    if (this.mode !== "on" || admission.kind !== "admitted" || admission.reservationId === null) return;
    try {
      const reservation = await this.core.store.getReservation(admission.reservationId);
      if (reservation?.status === "held" && reservation.subjectKind === "job" && reservation.subjectId === jobId) {
        await this.core.meter.releaseReservation({ reservationId: reservation.id, reason: "admission_abandoned" });
      }
    } catch (cause) {
      if (!(cause instanceof BillingNotFoundError)) this.logFailure("abandon", jobId, cause);
    }
  }

  /** Billing spec 10.5 step 2: after the usage record is stored. The call ID is the key. */
  async accrue(record: { jobId: string; callId: string; costUsd: string | null }): Promise<void> {
    if (this.mode === "off") return;
    try {
      if (this.mode === "shadow") {
        // Shadow holds nothing; the live meter still shows the computed numbers.
        if (this.deps.jobs.addCreditsEvent && this.creditsEventDue(record.jobId)) await this.emitShadowCreditsEvent(record.jobId);
        return;
      }
      const result = await this.core.meter.accrue({
        subject: { kind: "job", id: record.jobId },
        callId: record.callId,
        costUsd: record.costUsd,
      });
      if (result.status === "accrued" && this.deps.jobs.addCreditsEvent && this.creditsEventDue(record.jobId)) {
        await this.emitCreditsEvent(record.jobId);
      }
    } catch (cause) {
      // The usage record is stored; the sweep and the settle still see the run.
      this.logFailure("accrue", record.jobId, cause);
    }
  }

  /** Billing spec 10.5 step 4: the reason that `isJobActive` gives the worker. */
  async stopReason(jobId: string): Promise<GenerationStopReason | null> {
    if (this.mode !== "on") return null;
    try {
      return (await this.core.meter.status({ kind: "job", id: jobId })).stopReason;
    } catch (cause) {
      // A billing outage never stops a run.
      this.logFailure("status", jobId, cause);
      return null;
    }
  }

  /**
   * Billing spec 10.5 step 5: at the job's terminal transition. `outcome`
   * comes from the caller when it knows more than the status (a Doxabot run
   * that changed nothing, decision D12); else the job's status decides.
   * Settles every held reservation of the job, oldest first: a resumed job
   * keeps its ID and has one reservation for each admission.
   * Never throws: the job has ended either way, and the sweep retries.
   */
  async settle(jobId: string, outcome?: RunOutcome): Promise<void> {
    if (this.mode === "off") return;
    try {
      const facts = await this.deps.jobs.getFacts(jobId);
      if (!facts) return;
      // `on`: the action that the admission held credits for. The baseline
      // column can be cleared after the run (the version is collected), and
      // the charge rule must match the hold.
      const action = this.mode === "on" ? await this.heldActionOf(jobId) : meteredActionOf(facts);
      if (!action) return; // admitted before the meter was on
      const resolved = outcome ?? outcomeOfFacts(facts, action);
      if (!resolved) return;
      const chargeKey = chargeOutcomeFor(action, resolved);
      if (this.mode === "shadow") {
        await this.shadowSettle(jobId, facts, action, chargeKey);
        return;
      }
      await this.accrueMissedUsage(jobId);
      const result = await this.core.meter.settle({ subject: { kind: "job", id: jobId }, outcome: chargeKey });
      if (result.outcome === "settled") {
        // The last live event is up to 5 seconds old: show the final charge.
        await this.emitCreditsEvent(jobId).catch((cause: unknown) => this.logFailure("credits_event", jobId, cause));
        await this.notifyAfterSettle(jobId);
      }
    } catch (cause) {
      if (cause instanceof BillingNotFoundError) return; // admitted before the meter was on
      this.logFailure("settle", jobId, cause);
    } finally {
      lastCreditsEvent.delete(jobId);
    }
  }

  /**
   * Billing spec 10.5 "Charge rules": the cron settles every hold whose job
   * ended (a crashed worker, a missed settle) and releases holds older than
   * 24 hours whose job is gone.
   */
  async sweep(): Promise<{ settled: number; released: number }> {
    if (this.mode !== "on") return { settled: 0, released: 0 };
    const { store, clock, meter } = this.core;
    const now = clock.now();
    const held = await store.listReservations({ status: "held", limit: SWEEP_BATCH });
    let settled = 0;
    let released = 0;
    for (const reservation of held) {
      if (reservation.subjectKind !== "job") continue;
      try {
        const facts = await this.deps.jobs.getFacts(reservation.subjectId);
        if (!facts) {
          if (now.getTime() - reservation.createdAt.getTime() < ORPHAN_HOLD_MS) continue;
          const result = await meter.releaseReservation({ reservationId: reservation.id, reason: "job_gone" });
          if (result.outcome === "released") released += 1;
          continue;
        }
        if (!TERMINAL.has(facts.status)) continue;
        // The action of the hold itself, not of the job's current baseline.
        const action = isMeteredAction(reservation.actionKey) ? reservation.actionKey : meteredActionOf(facts);
        const outcome = outcomeOfFacts(facts, action);
        if (!outcome) continue;
        await this.accrueMissedUsage(reservation.subjectId);
        // By the reservation's own ID: a resumed job keeps its job ID, so an
        // older hold of it must not wait for the newest one.
        const result = await meter.settleReservation({
          reservationId: reservation.id,
          subject: { kind: "job", id: reservation.subjectId },
          outcome: chargeOutcomeFor(action, outcome),
        });
        settled += 1;
        if (result.outcome === "settled") await this.notifyAfterSettle(reservation.subjectId);
      } catch (cause) {
        this.logFailure("sweep", reservation.subjectId, cause);
      }
    }
    return { settled, released };
  }

  /**
   * The action that the job's newest hold was opened for, or null when the
   * meter holds nothing for it (`off`, `shadow`, or admitted before `on`). A
   * continued run keeps the action of its first admission with this.
   */
  async heldActionOf(jobId: string): Promise<MeteredAction | null> {
    if (this.mode !== "on") return null;
    const reservation = await this.core.store.findReservationBySubject("job", jobId);
    return reservation && isMeteredAction(reservation.actionKey) ? reservation.actionKey : null;
  }

  // Internals ---------------------------------------------------------------

  /**
   * Accrues the usage records whose accrual failed after the insert, before
   * a charge, so a database error does not lose the cost of a model call.
   * Only the records since the running try's hold opened: a call that came
   * after an earlier try settled stays uncharged (spec 10.5 step 6). An
   * accrual is keyed by its call ID, so a call that is already in adds
   * nothing. An error here stops the charge; the sweep tries again.
   */
  private async accrueMissedUsage(jobId: string): Promise<void> {
    const subject = { kind: "job", id: jobId };
    const reservation = await this.core.meter.activeReservationOf(subject);
    if (reservation?.status !== "held") return;
    // The query returns a bounded batch; read again until nothing is left,
    // so the settle never closes the hold with calls still missing. A batch
    // with no new call (a call that does not accrue) ends the loop.
    const seen = new Set<string>();
    for (;;) {
      const missed = (await this.deps.jobs.unaccruedUsage(jobId, reservation.createdAt)).filter((record) => !seen.has(record.callId));
      if (missed.length === 0) break;
      for (const record of missed) {
        seen.add(record.callId);
        await this.core.meter.accrue({ subject, callId: record.callId, costUsd: record.costUsd });
      }
    }
    if (seen.size > 0) this.log("credits.accrual_recovered", { jobId, calls: seen.size });
  }

  /** The refusals that come before a hold: the plan feature, an unpriced model, the cost guard. */
  private async checkBeforeHold(run: MeteringRun, view: AccountBillingView): Promise<void> {
    for (const feature of run.features ?? [FEATURE_OF[run.action]]) {
      if (!hasFeature(view.entitlements, feature)) {
        throw new PlanLimitError({
          key: feature,
          limit: false,
          used: null,
          reason: view.entitlements.featureReasons[feature] ?? "not_in_plan",
        });
      }
    }
    const provider = this.deps.modelProvider ?? DEFAULT_MODEL_PROVIDER;
    const unpriced = [...new Set(run.models)].filter((model) => !isModelPriced(provider, model));
    if (unpriced.length > 0) {
      this.log("credits.unpriced_model", { jobId: run.jobId, action: run.action, models: unpriced.join(",") });
      throw new AiAdmissionError("model_unpriced", "A model of this run has no price, so Doxa cannot meter it.", { models: unpriced });
    }
    await this.checkCostGuard(run, view);
  }

  /** Billing spec 19: `safety.maxDailyModelCostUsdPerAccount`. */
  private async checkCostGuard(run: MeteringRun, view: AccountBillingView): Promise<void> {
    const { costs } = this.deps;
    const { ownerId, ownerKind, id: accountId } = view.account;
    if (!costs || ownerId === null) return;
    const since = startOfUtcDay(this.core.clock.now());
    const spent = parseUsd(await costs.modelCostUsdSince({ ownerKind, ownerId, since })) ?? 0n;
    const limit = parseUsd(this.core.catalog.safety.maxDailyModelCostUsdPerAccount);
    if (limit === null || spent <= limit) return;
    // An operator alert: an error line that the log alerts match on.
    console.error(
      JSON.stringify({
        service: "doxa-api",
        event: "billing.cost_guard",
        mode: this.mode,
        accountId,
        projectId: run.projectId,
        jobId: run.jobId,
        modelCostUsd: formatUsd12(spent),
        limitUsd: this.core.catalog.safety.maxDailyModelCostUsdPerAccount,
      }),
    );
    throw new AiAdmissionError("ai_paused_for_review", "AI runs of this account are paused for a review.", {
      accountId,
      resetsAt: new Date(since.getTime() + DAY_MS),
    });
  }

  /** 1.5 × the median usage of the last 5 settled runs of the action, else the default (spec 10.5 step 1). */
  private async estimateCredits(run: MeteringRun, view: AccountBillingView): Promise<number> {
    const pricing = meterPricingFor(this.core.catalog, run.action);
    if (!pricing) return 0;
    const cap = resolveCap(pricing, view.account.actionCaps[run.action] ?? null);
    const jobIds = await this.deps.jobs.recentJobIds(run.projectId, 20);
    const reservations = await Promise.all(
      jobIds.filter((id) => id !== run.jobId).map((id) => this.core.store.findReservationBySubject("job", id)),
    );
    const recentUsageCredits = reservations
      .filter((row) => row !== null && row.actionKey === run.action && row.status === "settled" && row.settledAmount !== null)
      .slice(0, ESTIMATE_HISTORY_RUNS)
      .map((row) => Math.max(0, (row?.settledAmount ?? 0) - (row?.baseCredits ?? 0)));
    return estimateRun({ pricing, capCredits: cap, recentUsageCredits }).estimateCredits;
  }

  private async shadowAdmit(run: MeteringRun): Promise<void> {
    const view = await this.core.entitlements.forProject(run.projectId);
    try {
      await this.checkBeforeHold(run, view);
    } catch (cause) {
      if (isBillingRefusal(cause)) {
        this.logRefusal(run, cause);
        return;
      }
      throw cause;
    }
    const pricing = meterPricingFor(this.core.catalog, run.action);
    if (!pricing || !view.entitlements.enforceCredits) return;
    const cap = resolveCap(pricing, view.account.actionCaps[run.action] ?? null);
    const hold = firstHoldCredits(pricing.baseCredits, await this.estimateCredits(run, view), cap);
    // Shadow reads the balance only.
    const balance = await this.core.ledger.balance(view.account.id, view.creditContext);
    if (hold > balance.available) {
      if (view.creditContext.trialing) await this.notifyTrialExhausted(view.account.id, view.creditContext, run.jobId);
      this.log("credits.shadow_refusal", {
        jobId: run.jobId,
        projectId: run.projectId,
        accountId: view.account.id,
        plan: view.entitlements.plan,
        action: run.action,
        code: "credits_exhausted",
        available: Math.max(0, balance.available),
        needed: hold,
      });
      return;
    }
    this.log("credits.shadow_reserve", {
      jobId: run.jobId,
      accountId: view.account.id,
      plan: view.entitlements.plan,
      action: run.action,
      amount: hold,
      capCredits: cap,
      available: balance.available,
    });
  }

  /** The price that `on` would debit, from the job's usage records. Nothing is written. */
  private async shadowSettle(jobId: string, facts: MeteringJobFacts, action: MeteredAction, chargeKey: string): Promise<void> {
    const pricing = meterPricingFor(this.core.catalog, action);
    if (!pricing) return;
    const account = await this.core.accounts.resolveBillingAccount(facts.projectId);
    const cap = resolveCap(pricing, account.actionCaps[action] ?? null);
    const cost = parseUsd(await this.deps.jobs.usageCostUsd(jobId)) ?? 0n;
    const usage = usageCredits(cost, pricing.markupHundredths, pricing.unitPriceCents);
    const rule = chargeRuleFor(pricing, chargeKey);
    const charged = chargeCredits({ rule, baseCredits: pricing.baseCredits, usageCredits: usage, capCredits: cap });
    this.log("credits.settle", {
      jobId,
      accountId: account.id,
      action,
      outcome: chargeKey,
      chargeRule: rule,
      charged,
      usageCredits: usage,
      baseCredits: pricing.baseCredits,
      capCredits: cap,
      modelCostUsd: formatUsd12(cost),
    });
    if (this.deps.notifier && charged > 0) {
      await this.safelyNotify(jobId, async () => {
        const context = await this.core.entitlements.creditContext(account.id);
        const snapshot = await readCreditSnapshot(this.core, account.id, context);
        if (!snapshot) return [];
        return creditNotifications(withProjectedDebit(snapshot, charged));
      });
    }
  }

  // Billing notifications (spec 10.7) -----------------------------------------

  /** After a real settle: the notices that the account's new balance calls for. */
  private async notifyAfterSettle(jobId: string): Promise<void> {
    if (!this.deps.notifier) return;
    await this.safelyNotify(jobId, async () => {
      const reservation = await this.core.store.findReservationBySubject("job", jobId);
      if (!reservation) return [];
      const context = await this.core.entitlements.creditContext(reservation.accountId);
      const snapshot = await readCreditSnapshot(this.core, reservation.accountId, context);
      return snapshot ? creditNotifications(snapshot) : [];
    });
  }

  /** An admission refused for `trial_credits`: the trial credits are used up. */
  private async notifyTrialExhausted(accountId: string, context: CreditContext, jobId: string): Promise<void> {
    if (!this.deps.notifier) return;
    await this.safelyNotify(jobId, async () => [
      {
        kind: "credits-exhausted",
        accountId,
        windowRef: context.trialGrant?.sourceRef ?? `anchor:${context.windowAnchor.toISOString()}`,
        trialCredits: context.trialGrant?.credits ?? null,
      },
    ]);
  }

  /** A notice never changes how a run ends: a failure is logged. */
  private async safelyNotify(jobId: string, collect: () => Promise<readonly BillingNotification[]>): Promise<void> {
    try {
      for (const notification of await collect()) await this.deps.notifier?.notify(notification);
    } catch (cause) {
      this.logFailure("notify", jobId, cause);
    }
  }

  /** At most one live credits event for each job in the interval (this process). */
  private creditsEventDue(jobId: string): boolean {
    const interval = this.deps.creditsEventIntervalMs ?? CREDITS_EVENT_INTERVAL_MS;
    const now = this.core.clock.now().getTime();
    const last = lastCreditsEvent.get(jobId);
    if (last !== undefined && now - last < interval) return false;
    if (lastCreditsEvent.size > 10_000) lastCreditsEvent.clear();
    lastCreditsEvent.set(jobId, now);
    return true;
  }

  /**
   * `on`: the running price, the hold and the cap of the reservation, and
   * the part of the price above the grants that are free for this run.
   */
  /**
   * The live meter of the job's newest try, with the total of the whole job:
   * a continued run adds the charges of its earlier tries, so the number on
   * the generation page only goes up.
   */
  private async emitCreditsEvent(jobId: string): Promise<void> {
    if (!this.deps.jobs.addCreditsEvent) return;
    const subject = { kind: "job", id: jobId };
    const reservation = await this.core.meter.activeReservationOf(subject);
    if (!reservation) return;
    const credits = await this.core.meter.creditsOf(subject);
    // Pay-as-you-go pays what the grants left for this try cannot. A settled
    // try already wrote its debt to the ledger, so it counts in `settledDebtCredits`.
    let heldPaygCredits = 0;
    if (reservation.status === "held") {
      const context = await this.core.entitlements.creditContext(reservation.accountId);
      const balance = await this.core.ledger.balance(reservation.accountId, context);
      const grantsForRun = Math.max(0, balance.granted - (balance.held - reservation.amount));
      heldPaygCredits = Math.max(0, credits.latestCredits - grantsForRun);
    }
    await this.deps.jobs.addCreditsEvent(jobId, {
      usedCredits: credits.latestCredits,
      jobUsedCredits: credits.usedCredits,
      holdCredits: reservation.amount,
      capCredits: reservation.capCredits,
      fromPaygCredits: credits.settledDebtCredits + heldPaygCredits,
      shadow: false,
    });
  }

  /** `shadow`: the same numbers from the job's usage records and the balance; nothing is held. */
  private async emitShadowCreditsEvent(jobId: string): Promise<void> {
    const facts = await this.deps.jobs.getFacts(jobId);
    if (!facts) return;
    const action = meteredActionOf(facts);
    const pricing = meterPricingFor(this.core.catalog, action);
    if (!pricing) return;
    const view = await this.core.entitlements.forProject(facts.projectId);
    const cap = resolveCap(pricing, view.account.actionCaps[action] ?? null);
    const cost = parseUsd(await this.deps.jobs.usageCostUsd(jobId)) ?? 0n;
    const usedCredits = Math.min(cap, pricing.baseCredits + usageCredits(cost, pricing.markupHundredths, pricing.unitPriceCents));
    const firstHold = firstHoldCredits(pricing.baseCredits, pricing.defaultEstimateCredits, cap);
    const balance = await this.core.ledger.balance(view.account.id, view.creditContext);
    const grantsForRun = Math.max(0, balance.granted - balance.held);
    await this.deps.jobs.addCreditsEvent?.(jobId, {
      usedCredits,
      // Shadow prices the job's usage records, which already cover every try.
      jobUsedCredits: usedCredits,
      holdCredits: Math.max(firstHold, usedCredits),
      capCredits: cap,
      fromPaygCredits: Math.max(0, usedCredits - grantsForRun),
      shadow: true,
    });
  }

  private logRefusal(run: MeteringRun, cause: BillingRefusal): void {
    const fields: Record<string, string | number | boolean | null> = {
      jobId: run.jobId,
      projectId: run.projectId,
      action: run.action,
      code: cause.code,
    };
    if (cause instanceof CreditsExhaustedError) {
      Object.assign(fields, {
        accountId: cause.details.accountId,
        available: cause.details.available,
        needed: cause.details.needed,
        reason: cause.details.reason,
      });
    } else if (cause instanceof PlanLimitError) {
      Object.assign(fields, { key: cause.details.key, reason: cause.details.reason ?? null });
    }
    this.log(this.mode === "shadow" ? "credits.shadow_refusal" : "credits.refusal", fields);
  }

  private logFailure(step: string, jobId: string, cause: unknown): void {
    const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error";
    console.warn(JSON.stringify({ service: "doxa-api", event: "credits.meter_error", mode: this.mode, step, jobId, message }));
  }
}

/** The outcome of an ended job from its status and its last terminal event. Null while it runs. */
export function outcomeOfFacts(facts: MeteringJobFacts, action: MeteredAction = meteredActionOf(facts)): RunOutcome | null {
  switch (facts.status) {
    case "queued":
    case "running":
      return null;
    case "failed":
      return "failed";
    case "stopped_credits":
      return "stopped";
    case "cancelled":
      return facts.terminalEvent?.type === "doxabot_superseded" ? "superseded" : "cancelled";
    case "succeeded": {
      // Decision D12 ("no change pays usage only") is for a warm `doxabot.run` only.
      if (action === "generation.run") return "succeeded";
      const regenerated = facts.terminalEvent?.data?.regeneratedPageCount;
      return typeof regenerated === "number" && regenerated === 0 ? "no_change" : "pages_changed";
    }
  }
}

/** The models of a run: planner, writer, and the fallback writer (the planner unless set). */
export function runModels(
  env: { DOXA_WRITER_FALLBACK_MODEL?: string },
  config: { plannerModel: string; writerModel: string },
): string[] {
  const fallback = env.DOXA_WRITER_FALLBACK_MODEL?.trim() || config.plannerModel;
  return [...new Set([config.plannerModel, config.writerModel, fallback])];
}

/** `DOXA_MODEL_PROVIDER` of the API: the same value as the agent worker. Default `anthropic`. */
export function meteringModelProvider(value: string | undefined): ModelProvider {
  const parsed = modelProviderSchema.safeParse(value?.trim() || DEFAULT_MODEL_PROVIDER);
  return parsed.success ? parsed.data : DEFAULT_MODEL_PROVIDER;
}
