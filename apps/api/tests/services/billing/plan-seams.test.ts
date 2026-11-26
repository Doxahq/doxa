import { FREE_ACCOUNTS_MOVE_KEY, FREE_TEAMS_PER_OWNER_KEY, PlanLimitError, type BillingEnforcement } from "@doxahq/billing";
import { subscriptionFixture } from "@doxahq/billing/testing";
import {
  FREE_PLAN_ENTITLEMENTS,
  FREE_PLAN_SEARCH_POLICY,
  FREE_PLAN_STORAGE_LIMITS,
  PAID_PLAN_SEARCH_POLICY,
} from "@doxahq/contracts/entitlements";
import { describe, expect, test } from "vitest";
import type { BillingDenial } from "../../../src/services/billing/enforcement";
import { dedupeStricterLimitLogs } from "../../../src/services/billing/enforcement";
import { createPlanSeams, legacySeamsFromEnv } from "../../../src/services/billing/plan-seams";
import { createBillingHarness } from "../../support/billing-harness";

const OWNER = "user-1";
const PROJECT = "project-a";
const OTHER_PROJECT = "project-b";
const TEAM = "team-1";

/** Today's production: every project on the paid search list. */
const LEGACY_ENV = { DOXA_PROD_SEARCH_PAID_PROJECT_IDS: "*" } as never;

function setup(mode: BillingEnforcement, options: { billingFails?: boolean } = {}) {
  const harness = createBillingHarness({ enforcement: mode });
  harness.billing.projects.set(PROJECT, { userId: OWNER });
  harness.billing.projects.set(OTHER_PROJECT, { userId: OWNER });
  const denials: BillingDenial[] = [];
  let builds = 0;
  const seams = createPlanSeams({
    mode,
    legacy: legacySeamsFromEnv(LEGACY_ENV),
    billing: () => {
      builds += 1;
      if (options.billingFails) throw new Error("billing store down");
      return harness.core;
    },
    log: (denial) => denials.push(denial),
  });
  return { harness, seams, denials, builds: () => builds };
}

async function subscribePro(harness: ReturnType<typeof createBillingHarness>, ownerKind: "user" | "team", ownerId: string) {
  const account = await harness.core.accounts.accountForOwner(ownerKind, ownerId);
  await harness.billing.setSubscription(subscriptionFixture({ accountId: account.id }));
  return account;
}

describe("BILLING_ENFORCEMENT=off", () => {
  test("answers with the legacy stubs and never builds billing", async () => {
    const { seams, denials, builds } = setup("off");
    await expect(seams.entitlements.getProjectEntitlements(PROJECT)).resolves.toEqual(FREE_PLAN_ENTITLEMENTS);
    await expect(seams.entitlements.getSearchPolicy(PROJECT)).resolves.toEqual(PAID_PLAN_SEARCH_POLICY);
    await expect(seams.searchPolicy.getSearchPolicy(PROJECT)).resolves.toEqual(PAID_PLAN_SEARCH_POLICY);
    await expect(seams.storageLimits.getStorageLimits(PROJECT)).resolves.toEqual(FREE_PLAN_STORAGE_LIMITS);
    await expect(seams.docsDomainLimit.getLimit({ userId: OWNER, projectId: PROJECT })).resolves.toBe(1);
    expect(seams.teamSeats.active).toBe(false);
    await expect(seams.teamSeats.assertSeatAvailable({ teamId: TEAM, used: 99 })).resolves.toBeUndefined();
    expect(builds()).toBe(0);
    expect(denials).toEqual([]);
  });
});

describe("BILLING_ENFORCEMENT=shadow", () => {
  test("returns today's values and logs where the plan is stricter", async () => {
    const { seams, denials } = setup("shadow");
    await expect(seams.entitlements.getProjectEntitlements(PROJECT)).resolves.toEqual(FREE_PLAN_ENTITLEMENTS);
    await expect(seams.searchPolicy.getSearchPolicy(PROJECT)).resolves.toEqual(PAID_PLAN_SEARCH_POLICY);
    await expect(seams.storageLimits.getStorageLimits(PROJECT)).resolves.toEqual(FREE_PLAN_STORAGE_LIMITS);
    expect(denials).toEqual([
      { key: "docs.branches_per_site", limit: 2, current: 10, mode: "shadow", kind: "stricter_limit", plan: "free", projectId: PROJECT },
      { key: "site.typesense_search", limit: false, current: true, mode: "shadow", kind: "stricter_limit", plan: "free", projectId: PROJECT },
    ]);
  });

  test("logs a refused seat and still allows it", async () => {
    const { seams, denials } = setup("shadow");
    await expect(seams.teamSeats.assertSeatAvailable({ teamId: TEAM, used: 1 })).resolves.toBeUndefined();
    expect(denials).toEqual([expect.objectContaining({ key: "team.seats", mode: "shadow", kind: "denied", plan: "free", limit: 1, used: 1 })]);
  });

  test("a billing failure never fails the request", async () => {
    const { seams, denials } = setup("shadow", { billingFails: true });
    await expect(seams.entitlements.getProjectEntitlements(PROJECT)).resolves.toEqual(FREE_PLAN_ENTITLEMENTS);
    await expect(seams.docsDomainLimit.getLimit({ userId: OWNER, projectId: PROJECT })).resolves.toBe(1);
    await expect(seams.teamSeats.assertSeatAvailable({ teamId: TEAM, used: 5 })).resolves.toBeUndefined();
    expect(denials).toEqual([]);
  });

  test("dedupes stricter-limit lines per project and key, never denied lines", () => {
    let now = 0;
    const lines: BillingDenial[] = [];
    const log = dedupeStricterLimitLogs((denial) => lines.push(denial), { ttlMs: 1_000, now: () => now });
    const stricter: BillingDenial = { key: "k", mode: "shadow", kind: "stricter_limit", plan: "free", projectId: "p", limit: 1 };
    log(stricter);
    log(stricter);
    log({ ...stricter, kind: "denied" });
    log({ ...stricter, kind: "denied" });
    now = 1_000;
    log(stricter);
    expect(lines.map((line) => line.kind)).toEqual(["stricter_limit", "denied", "denied", "stricter_limit"]);
  });
});

describe("BILLING_ENFORCEMENT=on", () => {
  test("a Free account gets the Free plan values", async () => {
    const { seams, denials } = setup("on");
    await expect(seams.entitlements.getProjectEntitlements(PROJECT)).resolves.toEqual({ removePoweredBy: false, maxBranchesPerSite: 2 });
    await expect(seams.entitlements.getSearchPolicy(PROJECT)).resolves.toEqual(FREE_PLAN_SEARCH_POLICY);
    await expect(seams.storageLimits.getStorageLimits(PROJECT)).resolves.toEqual(FREE_PLAN_STORAGE_LIMITS);
    expect(denials).toEqual([]);
  });

  test("a Pro account gets the Pro values, with unlimited mapped to each contract's maximum", async () => {
    const { harness, seams } = setup("on");
    await subscribePro(harness, "user", OWNER);
    await expect(seams.entitlements.getProjectEntitlements(PROJECT)).resolves.toEqual({ removePoweredBy: true, maxBranchesPerSite: 1000 });
    await expect(seams.searchPolicy.getSearchPolicy(PROJECT)).resolves.toEqual(PAID_PLAN_SEARCH_POLICY);
    const storage = await seams.storageLimits.getStorageLimits(PROJECT);
    expect(storage.maxDocsStorageBytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(storage.maxSiteAssetFiles).toBe(Number.MAX_SAFE_INTEGER);
    expect(storage.maxSiteAssetBytes).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("the custom domain limit is for the account: other projects' domains use it up (D9)", async () => {
    const { harness, seams } = setup("on");
    await expect(seams.docsDomainLimit.getLimit({ userId: OWNER, projectId: PROJECT })).resolves.toBe(1);
    harness.usage.domains.set(OTHER_PROJECT, 1);
    await expect(seams.docsDomainLimit.getLimit({ userId: OWNER, projectId: PROJECT })).resolves.toBe(0);

    const pro = setup("on");
    await subscribePro(pro.harness, "user", OWNER);
    pro.harness.usage.domains.set(OTHER_PROJECT, 3);
    await expect(pro.seams.docsDomainLimit.getLimit({ userId: OWNER, projectId: PROJECT })).resolves.toBe(1);
  });

  test("a team project uses the team's account, not the owner's", async () => {
    const { harness, seams } = setup("on");
    harness.billing.projects.set("team-project", { userId: OWNER, teamId: TEAM });
    await subscribePro(harness, "team", TEAM);
    await expect(seams.entitlements.getProjectEntitlements("team-project")).resolves.toMatchObject({ maxBranchesPerSite: 1000 });
    await expect(seams.entitlements.getProjectEntitlements(PROJECT)).resolves.toMatchObject({ maxBranchesPerSite: 2 });
  });

  test("team seats: a Free team cannot add a member; a Pro team can", async () => {
    const { harness, seams, denials } = setup("on");
    const refused = seams.teamSeats.assertSeatAvailable({ teamId: TEAM, used: 1 });
    await expect(refused).rejects.toBeInstanceOf(PlanLimitError);
    const teamAccount = await harness.core.accounts.accountForOwner("team", TEAM);
    await expect(refused).rejects.toMatchObject({ details: { key: "team.seats", limit: 1, used: 1, accountId: teamAccount.id, plan: "free" } });
    expect(denials).toEqual([expect.objectContaining({ key: "team.seats", mode: "on", kind: "denied" })]);

    await subscribePro(harness, "team", TEAM);
    await expect(seams.teamSeats.assertSeatAvailable({ teamId: TEAM, used: 40 })).resolves.toBeUndefined();
  });

  test("reads the billing account once for each project in one seam set (spec 9.2)", async () => {
    const { harness, seams } = setup("on");
    let reads = 0;
    const load = harness.billing.store.loadAccountState.bind(harness.billing.store);
    harness.billing.store.loadAccountState = async (id) => {
      reads += 1;
      return load(id);
    };
    await seams.entitlements.getProjectEntitlements(PROJECT);
    await seams.entitlements.getSearchPolicy(PROJECT);
    await seams.storageLimits.getStorageLimits(PROJECT);
    expect(reads).toBe(1);
  });
});

describe("account.projects at project create", () => {
  const NEW_USER = "user-2";
  const MEMBER_OF_TEAM = "user-3";

  test("off: no count, no billing", async () => {
    const { seams, builds } = setup("off");
    expect(seams.projectLimit.active).toBe(false);
    await expect(seams.projectLimit.assertProjectAvailable({ userId: OWNER, teamId: null })).resolves.toBeUndefined();
    expect(builds()).toBe(0);
  });

  test("on: a Free account gets one project; the second is refused with the account and plan", async () => {
    const { harness, seams, denials } = setup("on");
    await expect(seams.projectLimit.assertProjectAvailable({ userId: NEW_USER, teamId: null })).resolves.toBeUndefined();

    harness.billing.projects.set("new-user-project", { userId: NEW_USER });
    const account = await harness.core.accounts.accountForOwner("user", NEW_USER);
    const refused = seams.projectLimit.assertProjectAvailable({ userId: NEW_USER, teamId: null });
    await expect(refused).rejects.toBeInstanceOf(PlanLimitError);
    await expect(refused).rejects.toMatchObject({
      details: { key: "account.projects", limit: 1, used: 1, accountId: account.id, plan: "free" },
    });
    expect(denials).toEqual([
      expect.objectContaining({ key: "account.projects", mode: "on", kind: "denied", plan: "free", accountId: account.id, limit: 1, used: 1 }),
    ]);
  });

  test("on: Pro allows 10 projects", async () => {
    const { harness, seams } = setup("on");
    await subscribePro(harness, "user", OWNER);
    for (let index = 0; index < 7; index += 1) harness.billing.projects.set(`pro-${index}`, { userId: OWNER });
    // 2 from setup + 7 = 9: the tenth fits.
    await expect(seams.projectLimit.assertProjectAvailable({ userId: OWNER, teamId: null })).resolves.toBeUndefined();
    harness.billing.projects.set("pro-9", { userId: OWNER });
    await expect(seams.projectLimit.assertProjectAvailable({ userId: OWNER, teamId: null })).rejects.toMatchObject({
      details: { key: "account.projects", limit: 10, used: 10 },
    });
  });

  test("on: a team project counts against the team's account, not the user's", async () => {
    const { harness, seams } = setup("on");
    // The owner's personal account is full (2 projects on Free); the team has none.
    await expect(seams.projectLimit.assertProjectAvailable({ userId: OWNER, teamId: TEAM })).resolves.toBeUndefined();
    harness.billing.projects.set("team-project", { userId: MEMBER_OF_TEAM, teamId: TEAM });
    await expect(seams.projectLimit.assertProjectAvailable({ userId: OWNER, teamId: TEAM })).rejects.toMatchObject({
      details: { key: "account.projects", used: 1 },
    });
    await expect(seams.projectLimit.assertProjectAvailable({ userId: OWNER, teamId: null })).rejects.toMatchObject({
      details: { key: "account.projects", used: 2 },
    });
  });

  test("shadow: logs the denial and allows the project", async () => {
    const { seams, denials } = setup("shadow");
    await expect(seams.projectLimit.assertProjectAvailable({ userId: OWNER, teamId: null })).resolves.toBeUndefined();
    expect(denials).toEqual([expect.objectContaining({ key: "account.projects", mode: "shadow", kind: "denied", used: 2 })]);
  });
});

describe("one Free team per owner at team create (decided 2026-11-26)", () => {
  const FREE_TEAM = "team-free";
  const PRO_TEAM = "team-pro";

  test("off: no check, and billing is never built", async () => {
    const { seams, builds } = setup("off");
    expect(seams.teamCreation.active).toBe(false);
    await expect(seams.teamCreation.assertTeamCreationAllowed({ userId: OWNER, ownedTeamIds: [FREE_TEAM] })).resolves.toBeUndefined();
    expect(builds()).toBe(0);
  });

  test("on: a user who owns no team may create one, without a billing read", async () => {
    const { seams, denials, builds } = setup("on");
    await expect(seams.teamCreation.assertTeamCreationAllowed({ userId: OWNER, ownedTeamIds: [] })).resolves.toBeUndefined();
    expect(builds()).toBe(0);
    expect(denials).toEqual([]);
  });

  test("on: a user who owns a Free team is refused with that team's account", async () => {
    const { harness, seams, denials } = setup("on");
    const freeTeam = await harness.core.accounts.accountForOwner("team", FREE_TEAM);
    const refused = seams.teamCreation.assertTeamCreationAllowed({ userId: OWNER, ownedTeamIds: [FREE_TEAM] });
    await expect(refused).rejects.toBeInstanceOf(PlanLimitError);
    await expect(refused).rejects.toMatchObject({
      details: { key: FREE_TEAMS_PER_OWNER_KEY, limit: 1, used: 1, accountId: freeTeam.id, plan: "free" },
    });
    expect(denials).toEqual([
      expect.objectContaining({ key: FREE_TEAMS_PER_OWNER_KEY, mode: "on", kind: "denied", plan: "free", accountId: freeTeam.id, limit: 1, used: 1 }),
    ]);
  });

  test("on: the owner of only Pro teams may create a team", async () => {
    const { harness, seams, denials } = setup("on");
    await subscribePro(harness, "team", PRO_TEAM);
    await expect(seams.teamCreation.assertTeamCreationAllowed({ userId: OWNER, ownedTeamIds: [PRO_TEAM] })).resolves.toBeUndefined();
    expect(denials).toEqual([]);
  });

  test("on: the owner of a paid team has no limit, with any number of Free teams", async () => {
    const { harness, seams, denials } = setup("on");
    await subscribePro(harness, "team", PRO_TEAM);
    await expect(
      seams.teamCreation.assertTeamCreationAllowed({ userId: OWNER, ownedTeamIds: [FREE_TEAM, PRO_TEAM, "team-free-2"] }),
    ).resolves.toBeUndefined();
    expect(denials).toEqual([]);
  });

  test("on: a paid personal account has no limit", async () => {
    const { harness, seams } = setup("on");
    await subscribePro(harness, "user", OWNER);
    await expect(seams.teamCreation.assertTeamCreationAllowed({ userId: OWNER, ownedTeamIds: [FREE_TEAM, "team-free-2"] })).resolves.toBeUndefined();
  });

  test("on: a past-due team still counts as a paying customer", async () => {
    const { harness, seams } = setup("on");
    const account = await harness.core.accounts.accountForOwner("team", PRO_TEAM);
    await harness.billing.setSubscription(subscriptionFixture({ accountId: account.id, status: "past_due" }));
    await expect(seams.teamCreation.assertTeamCreationAllowed({ userId: OWNER, ownedTeamIds: [FREE_TEAM, PRO_TEAM] })).resolves.toBeUndefined();
  });

  test("on: a trial is not paid, so it keeps the limit; the refusal names the oldest Free team", async () => {
    const { harness, seams } = setup("on");
    const trialTeam = await harness.core.accounts.accountForOwner("team", "team-trial");
    await harness.billing.setSubscription(subscriptionFixture({ accountId: trialTeam.id, status: "trialing" }));
    const personal = await harness.core.accounts.accountForOwner("user", OWNER);
    await harness.billing.setSubscription(subscriptionFixture({ accountId: personal.id, status: "trialing" }));
    const oldestFree = await harness.core.accounts.accountForOwner("team", FREE_TEAM);
    await expect(
      seams.teamCreation.assertTeamCreationAllowed({ userId: OWNER, ownedTeamIds: ["team-trial", FREE_TEAM, "team-free-2"] }),
    ).rejects.toMatchObject({ details: { key: FREE_TEAMS_PER_OWNER_KEY, used: 2, accountId: oldestFree.id } });
    // The team in its trial is not Free, so it uses no Free slot.
    await expect(seams.teamCreation.assertTeamCreationAllowed({ userId: OWNER, ownedTeamIds: ["team-trial"] })).resolves.toBeUndefined();
  });

  test("on: a cancelled subscription is not paid", async () => {
    const { harness, seams } = setup("on");
    const personal = await harness.core.accounts.accountForOwner("user", OWNER);
    await harness.billing.setSubscription(subscriptionFixture({ accountId: personal.id, status: "canceled" }));
    await expect(seams.teamCreation.assertTeamCreationAllowed({ userId: OWNER, ownedTeamIds: [FREE_TEAM] })).rejects.toMatchObject({
      details: { key: FREE_TEAMS_PER_OWNER_KEY },
    });
  });

  test("shadow: logs the denial and allows the team", async () => {
    const { seams, denials } = setup("shadow");
    await expect(seams.teamCreation.assertTeamCreationAllowed({ userId: OWNER, ownedTeamIds: [FREE_TEAM] })).resolves.toBeUndefined();
    expect(denials).toEqual([expect.objectContaining({ key: FREE_TEAMS_PER_OWNER_KEY, mode: "shadow", kind: "denied", plan: "free" })]);
  });

  test("shadow: a billing failure is logged and never fails the request", async () => {
    const { seams, denials } = setup("shadow", { billingFails: true });
    await expect(seams.teamCreation.assertTeamCreationAllowed({ userId: OWNER, ownedTeamIds: [FREE_TEAM] })).resolves.toBeUndefined();
    expect(denials).toEqual([]);
  });

  test("on: a billing failure fails the request", async () => {
    const { seams } = setup("on", { billingFails: true });
    await expect(seams.teamCreation.assertTeamCreationAllowed({ userId: OWNER, ownedTeamIds: [FREE_TEAM] })).rejects.toThrow(
      "billing store down",
    );
  });
});

describe("no project move between two Free accounts (decided 2026-11-26)", () => {
  const FREE_TEAM = "team-free";
  const OTHER_FREE_TEAM = "team-free-2";
  const TEAM_PROJECT = "project-team";
  const toTeam = (teamId: string) => ({ ownerKind: "team" as const, ownerId: teamId });
  const toPersonal = { ownerKind: "user" as const, ownerId: OWNER };

  function setupMove(mode: BillingEnforcement, options: { billingFails?: boolean } = {}) {
    const context = setup(mode, options);
    context.harness.billing.projects.set(TEAM_PROJECT, { userId: OWNER, teamId: FREE_TEAM });
    return context;
  }

  test("off: no check, and billing is never built", async () => {
    const { seams, builds } = setupMove("off");
    expect(seams.projectMove.active).toBe(false);
    await expect(seams.projectMove.assertMoveAllowed({ projectId: PROJECT, destination: toTeam(FREE_TEAM) })).resolves.toBeUndefined();
    expect(builds()).toBe(0);
  });

  test("on: personal Free to a Free team is refused with the team's account", async () => {
    const { harness, seams, denials } = setupMove("on");
    const team = await harness.core.accounts.accountForOwner("team", FREE_TEAM);
    const refused = seams.projectMove.assertMoveAllowed({ projectId: PROJECT, destination: toTeam(FREE_TEAM) });
    await expect(refused).rejects.toBeInstanceOf(PlanLimitError);
    await expect(refused).rejects.toMatchObject({
      details: { key: FREE_ACCOUNTS_MOVE_KEY, limit: false, used: null, accountId: team.id, plan: "free" },
    });
    expect(denials).toEqual([
      expect.objectContaining({ key: FREE_ACCOUNTS_MOVE_KEY, mode: "on", kind: "denied", plan: "free", projectId: PROJECT, accountId: team.id }),
    ]);
  });

  test("on: a Free team to personal Free is refused with the source team's account", async () => {
    const { harness, seams } = setupMove("on");
    const team = await harness.core.accounts.accountForOwner("team", FREE_TEAM);
    await expect(seams.projectMove.assertMoveAllowed({ projectId: TEAM_PROJECT, destination: toPersonal })).rejects.toMatchObject({
      details: { key: FREE_ACCOUNTS_MOVE_KEY, accountId: team.id },
    });
  });

  test("on: a Free team to another Free team is refused with the destination team's account", async () => {
    const { harness, seams } = setupMove("on");
    const destination = await harness.core.accounts.accountForOwner("team", OTHER_FREE_TEAM);
    await expect(
      seams.projectMove.assertMoveAllowed({ projectId: TEAM_PROJECT, destination: toTeam(OTHER_FREE_TEAM) }),
    ).rejects.toMatchObject({ details: { key: FREE_ACCOUNTS_MOVE_KEY, accountId: destination.id } });
  });

  test("on: a Pro source allows the move", async () => {
    const { harness, seams, denials } = setupMove("on");
    await subscribePro(harness, "user", OWNER);
    await expect(seams.projectMove.assertMoveAllowed({ projectId: PROJECT, destination: toTeam(FREE_TEAM) })).resolves.toBeUndefined();
    expect(denials).toEqual([]);
  });

  test("on: a Pro destination allows the move", async () => {
    const { harness, seams } = setupMove("on");
    await subscribePro(harness, "team", FREE_TEAM);
    await expect(seams.projectMove.assertMoveAllowed({ projectId: PROJECT, destination: toTeam(FREE_TEAM) })).resolves.toBeUndefined();
  });

  test("on: a Pro trial counts as Pro", async () => {
    const { harness, seams } = setupMove("on");
    const team = await harness.core.accounts.accountForOwner("team", FREE_TEAM);
    await harness.billing.setSubscription(subscriptionFixture({ accountId: team.id, status: "trialing" }));
    await expect(seams.projectMove.assertMoveAllowed({ projectId: PROJECT, destination: toTeam(FREE_TEAM) })).resolves.toBeUndefined();
  });

  test("on: a move that keeps the account needs no check", async () => {
    const { seams, denials } = setupMove("on");
    await expect(seams.projectMove.assertMoveAllowed({ projectId: TEAM_PROJECT, destination: toTeam(FREE_TEAM) })).resolves.toBeUndefined();
    await expect(seams.projectMove.assertMoveAllowed({ projectId: PROJECT, destination: toPersonal })).resolves.toBeUndefined();
    expect(denials).toEqual([]);
  });

  test("shadow: logs the denial and allows the move", async () => {
    const { seams, denials } = setupMove("shadow");
    await expect(seams.projectMove.assertMoveAllowed({ projectId: PROJECT, destination: toTeam(FREE_TEAM) })).resolves.toBeUndefined();
    expect(denials).toEqual([expect.objectContaining({ key: FREE_ACCOUNTS_MOVE_KEY, mode: "shadow", kind: "denied", plan: "free" })]);
  });

  test("shadow: a billing failure is logged and never fails the request", async () => {
    const { seams, denials } = setupMove("shadow", { billingFails: true });
    await expect(seams.projectMove.assertMoveAllowed({ projectId: PROJECT, destination: toTeam(FREE_TEAM) })).resolves.toBeUndefined();
    expect(denials).toEqual([]);
  });

  test("on: a billing failure fails the request", async () => {
    const { seams } = setupMove("on", { billingFails: true });
    await expect(seams.projectMove.assertMoveAllowed({ projectId: PROJECT, destination: toTeam(FREE_TEAM) })).rejects.toThrow(
      "billing store down",
    );
  });
});
