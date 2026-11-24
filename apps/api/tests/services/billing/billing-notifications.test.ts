import { DAY_MS, type BillingEnforcement, type BillingNotification } from "@doxahq/billing";
import { subscriptionFixture } from "@doxahq/billing/testing";
import { UnsubscribeTokens } from "@doxahq/email";
import { describe, expect, test, vi } from "vitest";
import type { BillingAudience, ProjectMember } from "../../../src/repositories/email-audience";
import { GenerationMetering, type MeteringJobFacts, type MeteringJobsPort } from "../../../src/services/billing/generation-metering";
import { EmailOutbox } from "../../../src/services/email/email-outbox";
import {
  BillingEmailNotifications,
  formatCents,
  formatDay,
  type BillingAccountOwner,
} from "../../../src/services/email/notifications/billing-notifications";
import { NotificationOutbox } from "../../../src/services/email/notifications/notification-outbox";
import { createBillingHarness, type BillingHarness } from "../../support/billing-harness";
import { InMemoryEmailStore, RecordingEmailQueue } from "../../support/in-memory-email-store";

const OWNER = "user-1";
const PROJECT = "project-a";
const MODELS = ["claude-sonnet-5-5", "claude-haiku-5-5"];
const links = { webOrigin: "https://doxa.so", apiOrigin: "https://api.doxa.so" };

const member = (userId: string, role: ProjectMember["role"]): ProjectMember => ({ userId, name: userId, email: `${userId}@example.com`, role });
const TEAM = [member("t-owner", "owner"), member("t-admin", "admin"), member("t-editor", "editor"), member("t-viewer", "viewer")];

const audience: BillingAudience = {
  contactsFor: async (ids) => new Map(ids.map((id) => [id, { userId: id, name: id, email: `${id}@example.com` }])),
  teamAudience: async (teamId) => (teamId === "team-1" ? { teamName: "Acme", members: TEAM } : null),
};

function notifierSetup(mode: BillingEnforcement, owner: (accountId: string) => Promise<BillingAccountOwner | null>) {
  const store = new InMemoryEmailStore();
  const queue = new RecordingEmailQueue();
  const outbox = new EmailOutbox({
    deliveries: store,
    preferences: store,
    queue,
    unsubscribe: new UnsubscribeTokens("x".repeat(32)),
    links,
    log: vi.fn(),
  });
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const notifier = new BillingEmailNotifications({
    mode,
    owner,
    audience,
    notifications: new NotificationOutbox(outbox, vi.fn()),
    links,
    unitPriceCents: 1,
    log: (event, fields) => logs.push({ event, fields }),
  });
  return { store, queue, notifier, logs };
}

class FakeJobs implements MeteringJobsPort {
  readonly facts = new Map<string, MeteringJobFacts>();
  job(jobId: string, status: MeteringJobFacts["status"]): void {
    this.facts.set(jobId, { projectId: PROJECT, status, publicationMode: "production", trigger: "manual", baselineVersionId: null, terminalEvent: null });
  }
  async getFacts(jobId: string) {
    return this.facts.get(jobId) ?? null;
  }
  async usageCostUsd(): Promise<string | null> {
    return null;
  }
  async recentJobIds() {
    return [];
  }
  async unaccruedUsage() {
    return [];
  }
}

function meteringSetup(mode: BillingEnforcement) {
  const harness = createBillingHarness({ enforcement: mode });
  harness.billing.projects.set(PROJECT, { userId: OWNER });
  const email = notifierSetup(mode, (id) => harness.core.store.getAccount(id));
  const jobs = new FakeJobs();
  let builds = 0;
  const metering = new GenerationMetering({
    mode,
    core: () => {
      builds += 1;
      return harness.core;
    },
    jobs,
    modelProvider: "anthropic",
    log: () => undefined,
    notifier: email.notifier,
  });
  return { harness, metering, jobs, ...email, builds: () => builds };
}

async function subscribe(harness: BillingHarness, overrides: Partial<Parameters<typeof subscriptionFixture>[0]> = {}) {
  const account = await harness.core.accounts.accountForOwner("user", OWNER);
  await harness.billing.setSubscription(subscriptionFixture({ accountId: account.id, ...overrides }));
  return account;
}

/** One finished generation that costs `usd` of model cost (credits = 50 + usd × 300). */
async function run(setup: ReturnType<typeof meteringSetup>, jobId: string, usd: string) {
  const admission = await setup.metering.admit({ jobId, projectId: PROJECT, action: "generation.run", models: MODELS });
  expect(admission.kind).toBe("admitted");
  await setup.metering.accrue({ jobId, callId: `${jobId}:1`, costUsd: usd });
  setup.jobs.job(jobId, "succeeded");
  await setup.metering.settle(jobId);
}

const kinds = (store: InMemoryEmailStore) => store.deliveries.map((row) => row.kind);

describe("billing emails from the meter (BILLING_ENFORCEMENT=on)", () => {
  test("credits-low fires once at 80% of the allowance, then payg-started and each payg-limit step once", async () => {
    const setup = meteringSetup("on");
    const account = await subscribe(setup.harness);

    for (const id of ["j0a", "j0b", "j0c", "j0d"]) await run(setup, id, "4.00"); // 4 × 1,250: 5,000 credits, 50%
    await run(setup, "j1", "9.00"); // +2,750: 7,750 = 77.5%
    expect(kinds(setup.store)).toEqual([]);

    await run(setup, "j2", "4.50"); // +1,400: 9,150 = 91.5%
    expect(kinds(setup.store)).toEqual(["credits-low"]);
    const [low] = setup.store.deliveries;
    expect(low).toMatchObject({ recipientEmail: `${OWNER}@example.com`, recipientUserId: OWNER });
    expect(low?.props).toMatchObject({ usedCredits: 9_150, allowanceCredits: 10_000, paygOn: true, billingUrl: `https://doxa.so/dashboard/billing/${account.id}` });
    expect(low?.props).not.toHaveProperty("unsubscribeUrl");

    await run(setup, "j3", "0.10"); // still in the 80% band: no second email
    expect(kinds(setup.store)).toEqual(["credits-low"]);

    // 10,000 − 9,230 = 770 left; this run costs 1,250, so 480 credits of debt.
    await run(setup, "j4", "4.00");
    expect(kinds(setup.store)).toEqual(["credits-low", "payg-started"]);
    expect(setup.store.deliveries[1]?.props).toMatchObject({ chargeAtUsd: "$5", monthlyLimitUsd: "$30" });

    // Stripe charges the debt at $5 (paid), so the debt room comes back; the window total keeps growing.
    await setup.harness.core.ledger.recordDebtPaid({ accountId: account.id, invoiceId: "in_1", credits: 480 });
    await run(setup, "j5", "2.50"); // +800: 1,280 of a 3,000-credit limit (42%)
    expect(kinds(setup.store)).toEqual(["credits-low", "payg-started"]);
    await setup.harness.core.ledger.recordDebtPaid({ accountId: account.id, invoiceId: "in_2", credits: 800 });
    await run(setup, "j6", "0.80"); // +290: 1,570 (52%)
    expect(kinds(setup.store)).toEqual(["credits-low", "payg-started", "payg-limit"]);
    expect(setup.store.deliveries[2]?.props).toMatchObject({ percent: 50, spentUsd: "$15.70", monthlyLimitUsd: "$30" });

    await run(setup, "j7", "0.10"); // still in the 50% band: nothing new
    expect(kinds(setup.store)).toEqual(["credits-low", "payg-started", "payg-limit"]);
  });

  test("credits-exhausted fires once when a trial admission is refused, not on the second refusal", async () => {
    const setup = meteringSetup("on");
    const now = setup.harness.billing.clock.now();
    await subscribe(setup.harness, { status: "trialing", trialEnd: new Date(now.getTime() + 7 * DAY_MS) });
    await run(setup, "t1", "3.00"); // 950 of the 1,000 trial credits
    expect(kinds(setup.store)).toEqual([]);

    for (const jobId of ["t2", "t3"]) {
      const admission = await setup.metering.admit({ jobId, projectId: PROJECT, action: "generation.run", models: MODELS });
      expect(admission.kind).toBe("refused");
    }
    expect(kinds(setup.store)).toEqual(["credits-exhausted"]);
    expect(setup.store.deliveries[0]?.props).toMatchObject({ trialCredits: 1_000 });
  });

  test("a notifier failure never fails the settle", async () => {
    const harness = createBillingHarness({ enforcement: "on" });
    harness.billing.projects.set(PROJECT, { userId: OWNER });
    await subscribe(harness);
    const jobs = new FakeJobs();
    const metering = new GenerationMetering({
      mode: "on",
      core: () => harness.core,
      jobs,
      modelProvider: "anthropic",
      log: () => undefined,
      notifier: { notify: async () => Promise.reject(new Error("email down")) },
    });
    await metering.admit({ jobId: "j1", projectId: PROJECT, action: "generation.run", models: MODELS });
    await metering.accrue({ jobId: "j1", callId: "c", costUsd: "15" });
    jobs.job("j1", "succeeded");
    await expect(metering.settle("j1")).resolves.toBeUndefined();
    expect((await harness.core.store.findReservationBySubject("job", "j1"))?.status).toBe("settled");
  });
});

describe("BILLING_ENFORCEMENT modes", () => {
  test("off: no email and no billing build", async () => {
    const setup = meteringSetup("off");
    await setup.metering.admit({ jobId: "j1", projectId: PROJECT, action: "generation.run", models: MODELS });
    setup.jobs.job("j1", "succeeded");
    await setup.metering.settle("j1");
    expect(setup.builds()).toBe(0);
    expect(setup.store.deliveries).toEqual([]);
    const notice: BillingNotification = { kind: "credits-exhausted", accountId: "a", windowRef: "trial:x", trialCredits: null };
    await setup.notifier.notify(notice);
    expect(setup.store.deliveries).toEqual([]);
    expect(setup.logs).toEqual([]);
  });

  test("shadow: logs the email it would send and sends nothing", async () => {
    const setup = meteringSetup("shadow");
    await subscribe(setup.harness);
    // Real usage first (the shadow meter debits nothing): 4 × 1,550 = 6,200 credits.
    const account = await setup.harness.core.accounts.accountForOwner("user", OWNER);
    for (const id of ["real-1", "real-2", "real-3", "real-4"]) {
      const subject = { kind: "job", id };
      await setup.harness.core.meter.open({ accountId: account.id, actionKey: "generation.run", subject });
      await setup.harness.core.meter.accrue({ subject, callId: `${id}:c`, costUsd: "5.00" });
      await setup.harness.core.meter.settle({ subject, outcome: "succeeded" });
    }
    setup.jobs.job("j1", "running");
    await setup.metering.admit({ jobId: "j1", projectId: PROJECT, action: "generation.run", models: MODELS });
    // Shadow prices the run from its usage records: 50 + $8 × 300 = 2,450; with the real 6,200 that is 8,650 (86.5%).
    vi.spyOn(setup.jobs, "usageCostUsd").mockResolvedValue("8.00");
    setup.jobs.job("j1", "succeeded");
    await setup.metering.settle("j1");
    expect(setup.store.deliveries).toEqual([]);
    expect(setup.queue.messages).toEqual([]);
    expect(setup.logs).toEqual([
      { event: "billing.notification_shadow", fields: expect.objectContaining({ kind: "credits-low", key: expect.stringMatching(/^credits-low:/) }) },
    ]);
  });
});

describe("recipients", () => {
  const notice = (accountId: string): BillingNotification => ({ kind: "credits-exhausted", accountId, windowRef: "trial:sub_1", trialCredits: 1_000 });

  test("a personal account emails its owner", async () => {
    const { store, notifier } = notifierSetup("on", async () => ({ ownerKind: "user", ownerId: "ada" }));
    await notifier.notify(notice("acct-1"));
    expect(store.deliveries.map((row) => row.recipientEmail)).toEqual(["ada@example.com"]);
    expect(store.deliveries[0]?.dedupeKey).toBe("billing:credits-exhausted:acct-1:trial:sub_1:ada");
  });

  test("a team account emails the owner and the admins (billing.manage), with the team name", async () => {
    const { store, notifier } = notifierSetup("on", async () => ({ ownerKind: "team", ownerId: "team-1" }));
    await notifier.notify(notice("acct-team"));
    await notifier.notify(notice("acct-team"));
    expect(store.deliveries.map((row) => row.recipientEmail).sort()).toEqual(["t-admin@example.com", "t-owner@example.com"]);
    expect(store.deliveries[0]?.props).toMatchObject({ teamName: "Acme" });
  });

  test("an account whose owner is gone emails nobody", async () => {
    const { store, notifier } = notifierSetup("on", async () => ({ ownerKind: "user", ownerId: null }));
    await notifier.notify(notice("acct-1"));
    expect(store.deliveries).toEqual([]);
  });
});

describe("formatting", () => {
  test("amounts and dates", () => {
    expect(formatCents(3_000)).toBe("$30");
    expect(formatCents(1_240)).toBe("$12.40");
    expect(formatDay(new Date("2026-12-01T00:00:00Z"))).toBe("December 1, 2026");
  });
});
