import { CreditsExhaustedError, DAY_MS, PlanLimitError, type BillingEnforcement } from "@doxahq/billing";
import { insertLegacyHeldReservation, subscriptionFixture } from "@doxahq/billing/testing";
import type { GenerationCreditsEventData } from "@doxahq/contracts/billing";
import { describe, expect, test } from "vitest";
import {
  AiAdmissionError,
  GenerationMetering,
  chargeOutcomeFor,
  meteredActionOf,
  outcomeOfFacts,
  requiredFeaturesOf,
  runModels,
  type MeteringJobFacts,
  type MeteringJobsPort,
} from "../../../src/services/billing/generation-metering";
import { createBillingHarness, type BillingHarness } from "../../support/billing-harness";

const OWNER = "user-1";
const PROJECT = "project-a";
const MODELS = ["claude-sonnet-5-5", "claude-haiku-5-5"];

class FakeJobs implements MeteringJobsPort {
  readonly facts = new Map<string, MeteringJobFacts>();
  readonly costs = new Map<string, string>();
  readonly creditEvents: ({ jobId: string } & GenerationCreditsEventData)[] = [];
  /** Stored usage records, as the API inserts them before the accrual. */
  readonly usage: { jobId: string; callId: string; costUsd: string | null; createdAt: Date }[] = [];
  /** Call IDs that have an accrual row; the test fills it from the billing store. */
  accrued: (callId: string) => Promise<boolean> = async () => false;
  /** The most rows that one `unaccruedUsage` read returns, like the repository's limit. */
  unaccruedLimit = Number.POSITIVE_INFINITY;

  job(jobId: string, facts: Partial<MeteringJobFacts> = {}): void {
    this.facts.set(jobId, {
      projectId: PROJECT,
      status: "running",
      publicationMode: "production",
      trigger: "manual",
      baselineVersionId: null,
      terminalEvent: null,
      ...facts,
    });
  }

  async getFacts(jobId: string) {
    return this.facts.get(jobId) ?? null;
  }
  async usageCostUsd(jobId: string) {
    return this.costs.get(jobId) ?? null;
  }
  async recentJobIds() {
    return [];
  }
  async addCreditsEvent(jobId: string, data: GenerationCreditsEventData) {
    this.creditEvents.push({ jobId, ...data });
  }
  async unaccruedUsage(jobId: string, since: Date) {
    const rows = this.usage.filter((row) => row.jobId === jobId && row.createdAt.getTime() >= since.getTime());
    const missed: { callId: string; costUsd: string | null }[] = [];
    for (const row of rows) if (!(await this.accrued(row.callId))) missed.push({ callId: row.callId, costUsd: row.costUsd });
    return missed.slice(0, this.unaccruedLimit);
  }
}

interface Setup {
  harness: BillingHarness;
  metering: GenerationMetering;
  jobs: FakeJobs;
  logs: { event: string; fields: Record<string, unknown> }[];
  builds: () => number;
  costToday: { value: string | null };
}

function setup(mode: BillingEnforcement): Setup {
  const harness = createBillingHarness({ enforcement: mode });
  harness.billing.projects.set(PROJECT, { userId: OWNER });
  const jobs = new FakeJobs();
  const logs: Setup["logs"] = [];
  const costToday = { value: null as string | null };
  let builds = 0;
  const metering = new GenerationMetering({
    mode,
    core: () => {
      builds += 1;
      return harness.core;
    },
    jobs,
    costs: { modelCostUsdSince: async () => costToday.value },
    modelProvider: "anthropic",
    log: (event, fields) => logs.push({ event, fields }),
    creditsEventIntervalMs: 0,
  });
  return { harness, metering, jobs, logs, builds: () => builds, costToday };
}

async function accountOf(harness: BillingHarness) {
  return harness.core.accounts.accountForOwner("user", OWNER);
}

async function subscribe(harness: BillingHarness, overrides: Parameters<typeof subscriptionFixture>[0] extends infer T ? Partial<T> : never = {}) {
  const account = await accountOf(harness);
  await harness.billing.setSubscription(subscriptionFixture({ accountId: account.id, ...overrides }));
  return account;
}

/** Holds `amount` credits for another subject, so the run under test finds less. */
async function hold(harness: BillingHarness, accountId: string, amount: number) {
  const context = await harness.core.entitlements.creditContext(accountId);
  const id = crypto.randomUUID();
  await harness.core.ledger.reserve({
    accountId,
    actionKey: "generation.run",
    subjectKind: "test_hold",
    subjectId: id,
    amount,
    baseCredits: 0,
    capCredits: amount,
    markupHundredths: 300,
    unitPriceCents: 1,
    inFlightMarginCredits: 0,
    idempotencyKey: `test_hold:${id}`,
    context,
  });
}

function admitRun(metering: GenerationMetering, jobId: string, overrides: Partial<Parameters<GenerationMetering["admit"]>[0]> = {}) {
  return metering.admit({ jobId, projectId: PROJECT, action: "generation.run", models: MODELS, ...overrides });
}

/** A second held hold of the job, as a resume left it before `RESERVATION_IN_USE`. */
async function legacySecondHold(harness: BillingHarness, first: Awaited<ReturnType<typeof admitRun>>) {
  if (first.kind !== "admitted" || !first.reservationId) throw new Error("the first admission holds credits");
  const reservation = await harness.core.store.getReservation(first.reservationId);
  if (!reservation) throw new Error("the first hold exists");
  return insertLegacyHeldReservation(harness.core.store, reservation, {
    idempotencyKey: `job:${reservation.subjectId}:reserve:resume:1`,
    baseCredits: 0,
    amount: 400,
    at: harness.billing.clock.now(),
  });
}

async function reservationOf(harness: BillingHarness, jobId: string) {
  return harness.core.store.findReservationBySubject("job", jobId);
}

describe("BILLING_ENFORCEMENT=off", () => {
  test("makes no meter call and never builds billing", async () => {
    const { metering, jobs, builds, logs } = setup("off");
    jobs.job("job-1", { status: "succeeded" });
    await expect(admitRun(metering, "job-1")).resolves.toEqual({ kind: "admitted", metered: false, capCredits: null, reservationId: null });
    await metering.accrue({ jobId: "job-1", callId: "call-1", costUsd: "1.0" });
    await expect(metering.stopReason("job-1")).resolves.toBeNull();
    await metering.settle("job-1");
    await expect(metering.sweep()).resolves.toEqual({ settled: 0, released: 0 });
    expect(builds()).toBe(0);
    expect(logs).toEqual([]);
  });
});

describe("admission (BILLING_ENFORCEMENT=on)", () => {
  test("holds base + estimate for a Pro account", async () => {
    const { harness, metering } = setup("on");
    await subscribe(harness);
    const admission = await admitRun(metering, "job-1");
    expect(admission).toEqual({ kind: "admitted", metered: true, capCredits: 3_000, reservationId: expect.any(String) });
    expect(await reservationOf(harness, "job-1")).toMatchObject({ status: "held", amount: 450, baseCredits: 50 });
  });

  test("refuses a plan without the feature with plan_limit", async () => {
    const { harness, metering } = setup("on");
    const admission = await admitRun(metering, "job-1");
    expect(admission.kind).toBe("refused");
    if (admission.kind !== "refused") return;
    expect(admission.error).toBeInstanceOf(PlanLimitError);
    expect((admission.error as PlanLimitError).details).toMatchObject({ key: "ai.doxa_agent", limit: false, reason: "not_in_plan" });
    const doxabot = await metering.admit({ jobId: "job-2", projectId: PROJECT, action: "doxabot.run", models: MODELS });
    expect(doxabot.kind === "refused" && (doxabot.error as PlanLimitError).details.key).toBe("ai.doxabot");
    expect(await reservationOf(harness, "job-1")).toBeNull();
  });

  test("refuses a run whose planner, writer or fallback model has no price", async () => {
    const { harness, metering, logs } = setup("on");
    await subscribe(harness);
    const admission = await admitRun(metering, "job-1", { models: ["claude-sonnet-5-5", "claude-unknown-9"] });
    expect(admission.kind).toBe("refused");
    if (admission.kind !== "refused") return;
    expect(admission.error).toBeInstanceOf(AiAdmissionError);
    expect((admission.error as AiAdmissionError).code).toBe("model_unpriced");
    expect((admission.error as AiAdmissionError).details.models).toEqual(["claude-unknown-9"]);
    expect(logs.map((line) => line.event)).toContain("credits.unpriced_model");
    expect(await reservationOf(harness, "job-1")).toBeNull();
  });

  test("an OpenRouter run is priced by the provider", async () => {
    const harness = createBillingHarness({ enforcement: "on" });
    harness.billing.projects.set(PROJECT, { userId: OWNER });
    await subscribe(harness);
    const metering = new GenerationMetering({ mode: "on", core: () => harness.core, jobs: new FakeJobs(), modelProvider: "openrouter", log: () => undefined });
    await expect(admitRun(metering, "job-1", { models: ["anthropic/claude-sonnet-4.5"] })).resolves.toMatchObject({ kind: "admitted", metered: true });
  });

  test("the fallback writer defaults to the planner model", () => {
    expect(runModels({}, { plannerModel: "p", writerModel: "w" })).toEqual(["p", "w"]);
    expect(runModels({ DOXA_WRITER_FALLBACK_MODEL: "f" }, { plannerModel: "p", writerModel: "w" })).toEqual(["p", "w", "f"]);
  });

  async function refusalReason(prepare: (setup: Setup, accountId: string) => Promise<void>) {
    const context = setup("on");
    const account = await accountOf(context.harness);
    await prepare(context, account.id);
    const admission = await admitRun(context.metering, "job-under-test");
    expect(admission.kind).toBe("refused");
    if (admission.kind !== "refused") throw new Error("admitted");
    expect(admission.error).toBeInstanceOf(CreditsExhaustedError);
    const details = (admission.error as CreditsExhaustedError).details;
    expect(details.needed).toBe(450);
    expect(details.available).toBeLessThan(450);
    expect(details.resetsAt).toBeInstanceOf(Date);
    expect(await reservationOf(context.harness, "job-under-test")).toBeNull();
    return details.reason;
  }

  test("402 credits_exhausted with reason trial_credits", async () => {
    const reason = await refusalReason(async ({ harness }, accountId) => {
      await subscribe(harness, { status: "trialing", trialEnd: new Date(harness.billing.clock.now().getTime() + 7 * DAY_MS) });
      await hold(harness, accountId, 900);
    });
    expect(reason).toBe("trial_credits");
  });

  test("402 credits_exhausted with reason payg_off", async () => {
    const reason = await refusalReason(async ({ harness }, accountId) => {
      await subscribe(harness);
      await harness.core.settings.setPayg({ accountId, enabled: false });
      await hold(harness, accountId, 4_800);
    });
    expect(reason).toBe("payg_off");
  });

  test("402 credits_exhausted with reason max_debt", async () => {
    const reason = await refusalReason(async ({ harness }, accountId) => {
      await subscribe(harness);
      await harness.core.settings.setPayg({ accountId, enabled: true, monthlyLimitCents: 20_000 });
      await hold(harness, accountId, 5_000 + 700);
    });
    expect(reason).toBe("max_debt");
  });

  test("402 credits_exhausted with reason monthly_limit", async () => {
    const reason = await refusalReason(async ({ harness }, accountId) => {
      await subscribe(harness);
      await harness.core.settings.setPayg({ accountId, enabled: true, monthlyLimitCents: 500 });
      await hold(harness, accountId, 5_000 + 200);
    });
    expect(reason).toBe("monthly_limit");
  });

  test("402 credits_exhausted with reason past_due", async () => {
    const reason = await refusalReason(async ({ harness }, accountId) => {
      await subscribe(harness);
      await harness.core.settings.setPayg({ accountId, enabled: true });
      await harness.core.store.withAccountLock(accountId, harness.billing.clock.now(), (tx) =>
        tx.updateAccount({ aiPausedReason: "payment_failed" }),
      );
      await hold(harness, accountId, 4_800);
    });
    expect(reason).toBe("past_due");
  });

  test("the cost guard pauses AI admission above the daily model cost", async () => {
    const { harness, metering, costToday } = setup("on");
    await subscribe(harness);
    costToday.value = "75.000000000001";
    const admission = await admitRun(metering, "job-1");
    expect(admission.kind === "refused" && admission.error).toBeInstanceOf(AiAdmissionError);
    if (admission.kind !== "refused") return;
    expect((admission.error as AiAdmissionError).code).toBe("ai_paused_for_review");
    expect((admission.error as AiAdmissionError).details.resetsAt?.toISOString()).toBe("2026-11-14T00:00:00.000Z");
    costToday.value = "75";
    await expect(admitRun(metering, "job-2")).resolves.toMatchObject({ kind: "admitted" });
  });

  test("abandon frees the hold of a job that was never created", async () => {
    const { harness, metering } = setup("on");
    await subscribe(harness);
    const admission = await admitRun(metering, "job-1");
    await metering.abandon("job-1", admission);
    expect(await reservationOf(harness, "job-1")).toMatchObject({ status: "released" });
  });

  // 2026-11-16 reviews: continue A held credits, then continue B held credits
  // and reopened the job. A lost the reopen and released B's newer hold, so
  // the run went on without a usable hold and was never charged. Now a job
  // holds credits once at a time: B is refused while A holds.
  test("a second continue is refused while the first one holds credits, and the run is charged", async () => {
    const { harness, metering, jobs } = setup("on");
    await subscribe(harness);
    jobs.job("job-1");
    const first = await admitRun(metering, "job-1");
    await metering.accrue({ jobId: "job-1", callId: "call-1", costUsd: "0.1" });
    jobs.job("job-1", { status: "stopped_credits" });
    await metering.settle("job-1", "stopped");
    expect(first).toMatchObject({ kind: "admitted", metered: true });

    const a = await admitRun(metering, "job-1", { attempt: "resume:a" });
    const b = await admitRun(metering, "job-1", { attempt: "resume:b" });
    expect(b).toEqual({ kind: "busy" });
    // B has no hold, so it has nothing to free.
    await metering.abandon("job-1", b);
    if (a.kind !== "admitted" || !a.reservationId) throw new Error("continue A holds credits");
    jobs.job("job-1");
    expect(await harness.core.store.getReservation(a.reservationId)).toMatchObject({ status: "held" });

    await metering.accrue({ jobId: "job-1", callId: "call-2", costUsd: "1" });
    await expect(metering.stopReason("job-1")).resolves.toBeNull();
    jobs.job("job-1", { status: "succeeded" });
    await metering.settle("job-1");
    expect(await harness.core.store.getReservation(a.reservationId)).toMatchObject({ status: "settled", settledAmount: 300 });
  });
});

describe("accrual and stop (BILLING_ENFORCEMENT=on)", () => {
  test("a repeated usage record adds nothing", async () => {
    const { harness, metering, jobs } = setup("on");
    await subscribe(harness);
    await admitRun(metering, "job-1");
    await metering.accrue({ jobId: "job-1", callId: "call-1", costUsd: "0.10" });
    await metering.accrue({ jobId: "job-1", callId: "call-1", costUsd: "0.10" });
    expect((await reservationOf(harness, "job-1"))?.consumedCostPico).toBe(100_000_000_000n);
    expect(jobs.creditEvents).toEqual([
      { jobId: "job-1", usedCredits: 80, jobUsedCredits: 80, holdCredits: 450, capCredits: 3_000, fromPaygCredits: 0, shadow: false },
    ]);
  });

  test("the live credit meter sends at most one event in its interval", async () => {
    const harness = createBillingHarness({ enforcement: "on" });
    harness.billing.projects.set(PROJECT, { userId: OWNER });
    await subscribe(harness);
    const jobs = new FakeJobs();
    const metering = new GenerationMetering({ mode: "on", core: () => harness.core, jobs, log: () => undefined, creditsEventIntervalMs: 5_000 });
    await admitRun(metering, "job-throttle");
    await metering.accrue({ jobId: "job-throttle", callId: "c1", costUsd: "0.10" });
    await metering.accrue({ jobId: "job-throttle", callId: "c2", costUsd: "0.10" });
    harness.billing.clock.advance(5_000);
    await metering.accrue({ jobId: "job-throttle", callId: "c3", costUsd: "0.10" });
    expect(jobs.creditEvents.map((event) => event.usedCredits)).toEqual([80, 140]);
  });

  test("the live credit meter counts the part above the grants as pay-as-you-go", async () => {
    const { harness, metering, jobs } = setup("on");
    const account = await subscribe(harness);
    await harness.core.settings.setPayg({ accountId: account.id, enabled: true, monthlyLimitCents: 20_000 });
    await hold(harness, account.id, 4_900);
    await admitRun(metering, "job-1");
    // $0.50 at markup 3 = 150 credits + base 50 = 200; the grants have 100 left for this run.
    await metering.accrue({ jobId: "job-1", callId: "call-1", costUsd: "0.50" });
    expect(jobs.creditEvents.at(-1)).toMatchObject({ usedCredits: 200, fromPaygCredits: 100, shadow: false });
  });

  test("a usage record without a cost adds 0 and is counted as unpriced", async () => {
    const { harness, metering } = setup("on");
    await subscribe(harness);
    await admitRun(metering, "job-1");
    await metering.accrue({ jobId: "job-1", callId: "call-1", costUsd: null });
    expect((await reservationOf(harness, "job-1"))?.consumedCostPico).toBe(0n);
    expect(harness.billing.counters.map((counter) => counter.name)).toContain("credits.unpriced_model");
  });

  test("the cap of a run gives the stop reason credit_cap", async () => {
    const { harness, metering } = setup("on");
    const account = await subscribe(harness);
    await harness.core.settings.setCap({ accountId: account.id, actionKey: "generation.run", capCredits: 1_000 });
    await admitRun(metering, "job-1");
    await expect(metering.stopReason("job-1")).resolves.toBeNull();
    // $2.50 at markup 3 is 750 credits: price 800, within the 250-credit margin of the 1,000 cap.
    await metering.accrue({ jobId: "job-1", callId: "call-1", costUsd: "2.5" });
    await expect(metering.stopReason("job-1")).resolves.toBe("credit_cap");
  });

  test("credits that run out give the stop reason credits_exhausted", async () => {
    const { harness, metering } = setup("on");
    const account = await subscribe(harness);
    await harness.core.settings.setPayg({ accountId: account.id, enabled: false });
    await admitRun(metering, "job-1");
    await hold(harness, account.id, 5_000 - 450);
    await metering.accrue({ jobId: "job-1", callId: "call-1", costUsd: "1.0" });
    await expect(metering.stopReason("job-1")).resolves.toBe("credits_exhausted");
  });
});

// 2026-11-16 review: the API stores the usage record, then accrues it, and
// logs an accrual error. The worker does not send the record again, so the
// cost of that call was never charged.
describe("usage whose accrual failed (BILLING_ENFORCEMENT=on)", () => {
  test("the settle accrues it first, once, and leaves a late call of an earlier try out", async () => {
    const { harness, metering, jobs } = setup("on");
    await subscribe(harness);
    // The calls that the meter accrued; "lost" is stored but its accrual failed.
    const accrued = new Set(["try-1", "ok"]);
    jobs.accrued = async (callId) => accrued.has(callId);
    jobs.job("job-1");
    // The earlier try: stopped, then a late call of it arrived.
    await admitRun(metering, "job-1");
    await metering.accrue({ jobId: "job-1", callId: "try-1", costUsd: "0.1" });
    jobs.job("job-1", { status: "stopped_credits" });
    await metering.settle("job-1", "stopped");
    jobs.usage.push({ jobId: "job-1", callId: "late", costUsd: "1", createdAt: harness.billing.clock.now() });

    // The continue: one call accrued, one stored whose accrual failed.
    harness.billing.clock.advance(60_000);
    jobs.job("job-1");
    const second = await admitRun(metering, "job-1", { attempt: "resume:1" });
    if (second.kind !== "admitted" || !second.reservationId) throw new Error("the continue holds credits");
    jobs.usage.push({ jobId: "job-1", callId: "ok", costUsd: "0.1", createdAt: harness.billing.clock.now() });
    await metering.accrue({ jobId: "job-1", callId: "ok", costUsd: "0.1" });
    jobs.usage.push({ jobId: "job-1", callId: "lost", costUsd: "1", createdAt: harness.billing.clock.now() });

    jobs.job("job-1", { status: "succeeded" });
    await metering.settle("job-1");
    // 30 (ok) + 300 (lost), no base fee: the first try paid it. Not the late call.
    expect(await harness.core.store.getReservation(second.reservationId)).toMatchObject({ status: "settled", settledAmount: 330 });
  });

  // 2026-11-16 second review: the read is bounded, and the settle closed the
  // hold after the first batch, so the rest was never charged.
  test("the settle reads again until no missed call is left", async () => {
    const { harness, metering, jobs } = setup("on");
    await subscribe(harness);
    jobs.job("job-1");
    const admission = await admitRun(metering, "job-1");
    if (admission.kind !== "admitted" || !admission.reservationId) throw new Error("the run holds credits");
    const accrued = new Set<string>();
    jobs.accrued = async (callId) => accrued.has(callId);
    jobs.unaccruedLimit = 2;
    for (const callId of ["m1", "m2", "m3", "m4", "m5"]) {
      jobs.usage.push({ jobId: "job-1", callId, costUsd: "0.1", createdAt: harness.billing.clock.now() });
    }
    // The fake marks a call accrued once the meter has it.
    const accrue = harness.core.meter.accrue.bind(harness.core.meter);
    harness.core.meter.accrue = async (input) => {
      const result = await accrue(input);
      accrued.add(input.callId);
      return result;
    };
    jobs.job("job-1", { status: "succeeded" });
    await metering.settle("job-1");
    // 50 + 5 × 30
    expect(await harness.core.store.getReservation(admission.reservationId)).toMatchObject({ status: "settled", settledAmount: 200 });
  });
});

describe("settle (BILLING_ENFORCEMENT=on)", () => {
  async function settled(
    action: "generation.run" | "doxabot.run",
    facts: Partial<MeteringJobFacts>,
    outcome?: Parameters<GenerationMetering["settle"]>[1],
  ) {
    const { harness, metering, jobs } = setup("on");
    await subscribe(harness);
    // A warm preview is a doxabot.run; a manual run is a generation.run.
    const shape = action === "doxabot.run" ? { publicationMode: "preview" as const, trigger: "doxabot", baselineVersionId: "version-1" } : {};
    await metering.admit({ jobId: "job-1", projectId: PROJECT, action, models: MODELS });
    // $0.10 at markup 3 = 30 credits of usage.
    await metering.accrue({ jobId: "job-1", callId: "call-1", costUsd: "0.10" });
    jobs.job("job-1", { ...shape, ...facts });
    await metering.settle("job-1", outcome);
    return (await reservationOf(harness, "job-1"))?.settledAmount;
  }

  test("generation.run: succeeded, stopped and cancelled charge base + usage; failed charges 0", async () => {
    await expect(settled("generation.run", { status: "succeeded" })).resolves.toBe(80);
    await expect(settled("generation.run", { status: "stopped_credits" })).resolves.toBe(80);
    await expect(settled("generation.run", { status: "cancelled" })).resolves.toBe(80);
    await expect(settled("generation.run", { status: "failed" })).resolves.toBe(0);
  });

  test("doxabot.run: no change and superseded charge usage only (decision D12)", async () => {
    await expect(settled("doxabot.run", { status: "succeeded" }, "pages_changed")).resolves.toBe(50);
    await expect(settled("doxabot.run", { status: "succeeded" }, "no_change")).resolves.toBe(30);
    await expect(
      settled("doxabot.run", { status: "succeeded", terminalEvent: { type: "completed", data: { regeneratedPageCount: 0 } } }),
    ).resolves.toBe(30);
    await expect(
      settled("doxabot.run", { status: "cancelled", terminalEvent: { type: "doxabot_superseded", data: null } }),
    ).resolves.toBe(30);
    await expect(settled("doxabot.run", { status: "stopped_credits" })).resolves.toBe(50);
    await expect(settled("doxabot.run", { status: "failed" })).resolves.toBe(0);
  });

  test("a usage record after the settle is not charged", async () => {
    const { harness, metering, jobs } = setup("on");
    await subscribe(harness);
    await admitRun(metering, "job-1");
    jobs.job("job-1", { status: "succeeded" });
    await metering.settle("job-1");
    await metering.accrue({ jobId: "job-1", callId: "late", costUsd: "5" });
    expect((await reservationOf(harness, "job-1"))?.settledAmount).toBe(50);
    expect(harness.billing.counters.map((counter) => counter.name)).toContain("credits.late_usage");
  });

  test("a continued run holds and settles under its own key", async () => {
    const { harness, metering, jobs } = setup("on");
    await subscribe(harness);
    await admitRun(metering, "job-1");
    jobs.job("job-1", { status: "failed" });
    await metering.settle("job-1");
    await admitRun(metering, "job-1", { attempt: "resume:1" });
    await metering.accrue({ jobId: "job-1", callId: "call-2", costUsd: "0.10" });
    jobs.job("job-1", { status: "succeeded" });
    await metering.settle("job-1");
    expect(await reservationOf(harness, "job-1")).toMatchObject({ status: "settled", settledAmount: 80 });
  });

  test("a resumed job whose first settle failed: the terminal settle settles both holds, oldest first", async () => {
    const { harness, metering, jobs } = setup("on");
    await subscribe(harness);
    const first = await admitRun(metering, "job-1");
    await metering.accrue({ jobId: "job-1", callId: "call-1", costUsd: "0.10" });
    // The first run ended without a settle (a crashed worker); the resume
    // kept the job ID and opened a second hold, before a job could hold
    // credits only once at a time.
    harness.billing.clock.advance(60_000);
    await legacySecondHold(harness, first);
    await metering.accrue({ jobId: "job-1", callId: "call-2", costUsd: "0.20" });
    jobs.job("job-1", { status: "succeeded" });
    await metering.settle("job-1");
    const rows = await harness.core.store.listReservationsBySubject("job", "job-1");
    // The job pays the base fee once: the still-held first hold carries it.
    expect(rows.map((row) => [row.status, row.baseCredits, row.settledAmount])).toEqual([
      ["settled", 50, 80],
      ["settled", 0, 60],
    ]);
  });

  test("a continued job: the live meter shows the job total, which never goes down, and a final event after the settle", async () => {
    const { harness, metering, jobs } = setup("on");
    await subscribe(harness);
    await admitRun(metering, "job-1");
    await metering.accrue({ jobId: "job-1", callId: "call-1", costUsd: "0.10" });
    jobs.job("job-1", { status: "stopped_credits" });
    await metering.settle("job-1", "stopped");
    harness.billing.clock.advance(60_000);
    jobs.job("job-1", { status: "running" });
    await admitRun(metering, "job-1", { attempt: "resume:1" });
    harness.billing.clock.advance(60_000);
    await metering.accrue({ jobId: "job-1", callId: "call-2", costUsd: "0.20" });
    jobs.job("job-1", { status: "succeeded" });
    await metering.settle("job-1");
    expect(jobs.creditEvents.map(({ usedCredits, jobUsedCredits }) => [usedCredits, jobUsedCredits])).toEqual([
      [80, 80], // the first try, live
      [80, 80], // the first try, settled
      [60, 140], // the continue: usage only, on top of the first try
      [60, 140], // the continue, settled
    ]);
  });

  test("the sweep settles every held reservation of an ended resumed job by its ID", async () => {
    const { harness, metering, jobs } = setup("on");
    await subscribe(harness);
    const first = await admitRun(metering, "job-1");
    harness.billing.clock.advance(60_000);
    await legacySecondHold(harness, first);
    jobs.job("job-1", { status: "failed" });
    await expect(metering.sweep()).resolves.toEqual({ settled: 2, released: 0 });
    const rows = await harness.core.store.listReservationsBySubject("job", "job-1");
    expect(rows.map((row) => row.status)).toEqual(["settled", "settled"]);
    await expect(metering.sweep()).resolves.toEqual({ settled: 0, released: 0 });
  });

  test("the sweep settles the holds of ended jobs and releases old holds whose job is gone", async () => {
    const { harness, metering, jobs } = setup("on");
    await subscribe(harness);
    await admitRun(metering, "job-ended");
    await admitRun(metering, "job-running");
    await admitRun(metering, "job-gone");
    jobs.job("job-ended", { status: "failed" });
    jobs.job("job-running", { status: "running" });
    await expect(metering.sweep()).resolves.toEqual({ settled: 1, released: 0 });
    harness.billing.clock.advance(DAY_MS + 1);
    await expect(metering.sweep()).resolves.toEqual({ settled: 0, released: 1 });
    expect(await reservationOf(harness, "job-ended")).toMatchObject({ status: "settled", settledAmount: 0 });
    expect(await reservationOf(harness, "job-running")).toMatchObject({ status: "held" });
    expect(await reservationOf(harness, "job-gone")).toMatchObject({ status: "released" });
  });
});

describe("BILLING_ENFORCEMENT=shadow", () => {
  test("logs the hold and the charge, holds nothing and never refuses", async () => {
    const { harness, metering, jobs, logs } = setup("shadow");
    await subscribe(harness);
    await expect(admitRun(metering, "job-1")).resolves.toEqual({ kind: "admitted", metered: false, capCredits: null, reservationId: null });
    expect(await reservationOf(harness, "job-1")).toBeNull();
    await metering.accrue({ jobId: "job-1", callId: "call-1", costUsd: "0.10" });
    await expect(metering.stopReason("job-1")).resolves.toBeNull();
    jobs.job("job-1", { status: "succeeded" });
    jobs.costs.set("job-1", "0.100000000000");
    await metering.settle("job-1");
    expect(logs.find((line) => line.event === "credits.shadow_reserve")?.fields).toMatchObject({ mode: "shadow", amount: 450, action: "generation.run" });
    expect(logs.find((line) => line.event === "credits.settle")?.fields).toMatchObject({
      mode: "shadow",
      jobId: "job-1",
      outcome: "succeeded",
      charged: 80,
      usageCredits: 30,
    });
    const entries = await harness.core.store.listLedgerEntries((await accountOf(harness)).id, { limit: 100 });
    expect(entries.items.filter((entry) => entry.kind === "debit" || entry.kind === "debt")).toEqual([]);
  });

  test("the live credit meter shows the computed numbers in shadow", async () => {
    const { harness, metering, jobs } = setup("shadow");
    await subscribe(harness);
    jobs.job("job-1", { status: "running" });
    jobs.costs.set("job-1", "0.10");
    await metering.accrue({ jobId: "job-1", callId: "call-1", costUsd: "0.10" });
    expect(jobs.creditEvents).toEqual([
      { jobId: "job-1", usedCredits: 80, jobUsedCredits: 80, holdCredits: 450, capCredits: 3_000, fromPaygCredits: 0, shadow: true },
    ]);
    expect(await reservationOf(harness, "job-1")).toBeNull();
  });

  test("logs each refusal it would make and admits the run", async () => {
    const { metering, logs } = setup("shadow");
    await expect(admitRun(metering, "job-1")).resolves.toMatchObject({ kind: "admitted" });
    expect(logs).toEqual([
      expect.objectContaining({ event: "credits.shadow_refusal", fields: expect.objectContaining({ code: "plan_limit", key: "ai.doxa_agent" }) }),
    ]);
  });

  test("a billing error never blocks a run", async () => {
    const metering = new GenerationMetering({
      mode: "shadow",
      core: () => {
        throw new Error("billing store down");
      },
      jobs: new FakeJobs(),
      log: () => undefined,
    });
    await expect(admitRun(metering, "job-1")).resolves.toMatchObject({ kind: "admitted" });
    await expect(metering.settle("job-1")).resolves.toBeUndefined();
  });
});

describe("cold and warm Doxabot runs (BILLING_ENFORCEMENT=on)", () => {
  type Shape = Parameters<typeof meteredActionOf>[0];
  const COLD_PREVIEW: Shape = { publicationMode: "preview", trigger: "doxabot", baselineVersionId: null };
  const WARM_PREVIEW: Shape = { publicationMode: "preview", trigger: "doxabot", baselineVersionId: "version-1" };
  const COLD_MERGE: Shape = { publicationMode: "production", trigger: "merge", baselineVersionId: null };
  const WARM_MERGE: Shape = { publicationMode: "production", trigger: "merge", baselineVersionId: "version-1" };

  function admitShape(metering: GenerationMetering, jobId: string, shape: Shape) {
    return metering.admit({
      jobId,
      projectId: PROJECT,
      action: meteredActionOf(shape),
      features: requiredFeaturesOf(shape),
      models: MODELS,
    });
  }

  test("a cold preview holds as a generation.run: base 50, cap 3,000", async () => {
    const { harness, metering } = setup("on");
    await subscribe(harness);
    await expect(admitShape(metering, "job-1", COLD_PREVIEW)).resolves.toEqual({ kind: "admitted", metered: true, capCredits: 3_000, reservationId: expect.any(String) });
    expect(await reservationOf(harness, "job-1")).toMatchObject({ actionKey: "generation.run", status: "held", amount: 450, baseCredits: 50 });
  });

  test("a warm preview stays a doxabot.run: base 20, cap 500", async () => {
    const { harness, metering } = setup("on");
    await subscribe(harness);
    await expect(admitShape(metering, "job-1", WARM_PREVIEW)).resolves.toEqual({ kind: "admitted", metered: true, capCredits: 500, reservationId: expect.any(String) });
    expect(await reservationOf(harness, "job-1")).toMatchObject({ actionKey: "doxabot.run", baseCredits: 20 });
  });

  test("a cold merge run is a generation.run, a warm one a doxabot.run", async () => {
    const { harness, metering } = setup("on");
    await subscribe(harness);
    await admitShape(metering, "job-cold", COLD_MERGE);
    await admitShape(metering, "job-warm", WARM_MERGE);
    expect(await reservationOf(harness, "job-cold")).toMatchObject({ actionKey: "generation.run", baseCredits: 50, capCredits: 3_000 });
    expect(await reservationOf(harness, "job-warm")).toMatchObject({ actionKey: "doxabot.run", baseCredits: 20, capCredits: 500 });
  });

  test("a cold preview without ai.doxa_agent is refused for that feature; without ai.doxabot for Doxabot first", async () => {
    const { harness, metering } = setup("on");
    const account = await subscribe(harness);
    const override = (key: string) =>
      harness.core.store.insertOverride(
        { accountId: account.id, key, value: false, reason: "test", startsAt: null, expiresAt: null, createdBy: "test" },
        harness.core.clock.now(),
      );
    await override("ai.doxa_agent");
    const cold = await admitShape(metering, "job-1", COLD_PREVIEW);
    expect(cold.kind === "refused" && (cold.error as PlanLimitError).details.key).toBe("ai.doxa_agent");
    // A warm preview needs only ai.doxabot.
    await expect(admitShape(metering, "job-2", WARM_PREVIEW)).resolves.toMatchObject({ kind: "admitted", metered: true });
    await override("ai.doxabot");
    const doxabotOff = await admitShape(metering, "job-3", COLD_PREVIEW);
    expect(doxabotOff.kind === "refused" && (doxabotOff.error as PlanLimitError).details.key).toBe("ai.doxabot");
  });

  test("a cold preview that changed nothing pays base + usage (no D12 discount)", async () => {
    const { harness, metering, jobs } = setup("on");
    await subscribe(harness);
    await admitShape(metering, "job-1", COLD_PREVIEW);
    await metering.accrue({ jobId: "job-1", callId: "call-1", costUsd: "0.10" });
    jobs.job("job-1", { ...COLD_PREVIEW, status: "succeeded" });
    await metering.settle("job-1", "no_change");
    expect((await reservationOf(harness, "job-1"))?.settledAmount).toBe(80);
  });

  test("the settle and the sweep use the action of the hold, even after the baseline is cleared", async () => {
    const { harness, metering, jobs } = setup("on");
    await subscribe(harness);
    await admitShape(metering, "job-1", WARM_PREVIEW);
    await admitShape(metering, "job-2", WARM_PREVIEW);
    await metering.accrue({ jobId: "job-1", callId: "call-1", costUsd: "0.10" });
    await metering.accrue({ jobId: "job-2", callId: "call-2", costUsd: "0.10" });
    // The baseline version was collected: the column is null now.
    const ended = { status: "succeeded" as const, terminalEvent: { type: "completed", data: { regeneratedPageCount: 0 } } };
    jobs.job("job-1", { ...COLD_PREVIEW, ...ended });
    jobs.job("job-2", { ...COLD_PREVIEW, ...ended });
    await metering.settle("job-1");
    await expect(metering.sweep()).resolves.toMatchObject({ settled: 1 });
    // Decision D12 for the warm hold: usage only (30), not a generation.run charge.
    expect((await reservationOf(harness, "job-1"))?.settledAmount).toBe(30);
    expect((await reservationOf(harness, "job-2"))?.settledAmount).toBe(30);
  });

  test("heldActionOf reads the action of the job's hold, and null without one", async () => {
    const { harness, metering } = setup("on");
    await subscribe(harness);
    await admitShape(metering, "job-1", COLD_PREVIEW);
    await expect(metering.heldActionOf("job-1")).resolves.toBe("generation.run");
    await expect(metering.heldActionOf("job-none")).resolves.toBeNull();
    await expect(setup("shadow").metering.heldActionOf("job-1")).resolves.toBeNull();
  });
});

describe("outcome mapping", () => {
  const base: MeteringJobFacts = {
    projectId: PROJECT,
    status: "running",
    publicationMode: "production",
    trigger: "manual",
    baselineVersionId: null,
    terminalEvent: null,
  };
  const WARM = "version-1";

  test("a warm preview or merge run is a doxabot.run (decision D7)", () => {
    expect(meteredActionOf({ publicationMode: "preview", trigger: "doxabot", baselineVersionId: WARM })).toBe("doxabot.run");
    expect(meteredActionOf({ publicationMode: "production", trigger: "merge", baselineVersionId: WARM })).toBe("doxabot.run");
  });

  test("a cold preview or merge run (no baseline) is a generation.run", () => {
    expect(meteredActionOf({ publicationMode: "preview", trigger: "doxabot", baselineVersionId: null })).toBe("generation.run");
    expect(meteredActionOf({ publicationMode: "production", trigger: "merge", baselineVersionId: null })).toBe("generation.run");
  });

  test("a manual run is a generation.run, cold or warm", () => {
    expect(meteredActionOf({ publicationMode: "production", trigger: "manual", baselineVersionId: null })).toBe("generation.run");
    expect(meteredActionOf({ publicationMode: "production", trigger: "manual", baselineVersionId: WARM })).toBe("generation.run");
  });

  test("a Doxabot run needs ai.doxabot; a cold one also needs ai.doxa_agent", () => {
    expect(requiredFeaturesOf({ publicationMode: "preview", trigger: "doxabot", baselineVersionId: WARM })).toEqual(["ai.doxabot"]);
    expect(requiredFeaturesOf({ publicationMode: "preview", trigger: "doxabot", baselineVersionId: null })).toEqual([
      "ai.doxabot",
      "ai.doxa_agent",
    ]);
    expect(requiredFeaturesOf({ publicationMode: "production", trigger: "merge", baselineVersionId: null })).toEqual([
      "ai.doxabot",
      "ai.doxa_agent",
    ]);
    expect(requiredFeaturesOf({ publicationMode: "production", trigger: "manual", baselineVersionId: WARM })).toEqual(["ai.doxa_agent"]);
    // An explicit action (a continued run keeps its first action).
    expect(requiredFeaturesOf({ publicationMode: "preview", trigger: "doxabot", baselineVersionId: null }, "doxabot.run")).toEqual([
      "ai.doxabot",
    ]);
  });

  test("a cold Doxabot run that changed nothing pays the full generation rule, not D12", () => {
    const cold: MeteringJobFacts = {
      ...base,
      publicationMode: "preview",
      trigger: "doxabot",
      status: "succeeded",
      terminalEvent: { type: "completed", data: { regeneratedPageCount: 0 } },
    };
    expect(outcomeOfFacts(cold)).toBe("succeeded");
    expect(outcomeOfFacts({ ...cold, baselineVersionId: WARM })).toBe("no_change");
    expect(chargeOutcomeFor("generation.run", "no_change")).toBe("succeeded");
  });

  test("maps each end to the charge rule key of its action", () => {
    expect(outcomeOfFacts(base)).toBeNull();
    expect(outcomeOfFacts({ ...base, status: "stopped_credits" })).toBe("stopped");
    expect(chargeOutcomeFor("generation.run", "superseded")).toBe("cancelled");
    expect(chargeOutcomeFor("generation.run", "no_change")).toBe("succeeded");
    expect(chargeOutcomeFor("doxabot.run", "succeeded")).toBe("pages_changed");
  });
});
