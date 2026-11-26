import { FREE_TEAMS_PER_OWNER_KEY, type BillingEnforcement } from "@doxahq/billing";
import { subscriptionFixture } from "@doxahq/billing/testing";
import { planLimitErrorDetailsSchema } from "@doxahq/contracts/billing";
import { describe, expect, test, vi } from "vitest";
import { createApiRouter } from "../../src/http/app";
import { MembershipProjectAccessPolicy } from "../../src/services/agent-access/membership-project-access-policy";
import { createPlanSeams, legacySeamsFromEnv } from "../../src/services/billing/plan-seams";
import { HmacInviteTokens } from "../../src/services/teams/invite-token";
import { TeamService } from "../../src/services/teams/team-service";
import { createBillingHarness } from "../support/billing-harness";
import { InMemoryProjectAccess } from "../support/in-memory-project-access";
import { InMemoryTeamStore } from "../support/in-memory-team-store";
import { RecordingInviteMailer } from "../support/recording-invite-mailer";

const session = vi.hoisted(() => ({ userId: "owner-1" }));
vi.mock("../../src/http/auth", () => ({
  withUser: (_context: unknown, handler: (userId: string) => Promise<Response>) => handler(session.userId),
}));
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const { createTeamInviteRoutes, createTeamRoutes } = await import("../../src/routes/teams");

const OWNER = "owner-1";
const MEMBER = "member-1";
const SECRET = "test-auth-secret";

function setup(mode: BillingEnforcement) {
  const harness = createBillingHarness({ enforcement: mode });
  const access = new InMemoryProjectAccess({});
  const store = new InMemoryTeamStore(access, { [OWNER]: "Olivia" });
  let inviteIndex = 0;
  const seams = createPlanSeams({ mode, legacy: legacySeamsFromEnv({} as never), billing: () => harness.core, log: () => undefined });
  const service = new TeamService({
    store,
    projects: new MembershipProjectAccessPolicy(access),
    now: () => harness.billing.clock.now(),
    tokens: new HmacInviteTokens(SECRET),
    newId: () => `aaaaaaaa-0000-4000-8000-${String((inviteIndex += 1)).padStart(12, "0")}`,
    inviteMailer: new RecordingInviteMailer(),
    seats: seams.teamSeats,
    teamCreation: seams.teamCreation,
  });
  const app = createApiRouter();
  app.route("/teams", createTeamRoutes(() => service));
  app.route("/team-invites", createTeamInviteRoutes(() => service));
  const send = (userId: string, path: string, method = "GET", body?: unknown) => {
    session.userId = userId;
    return app.request(
      `https://api.doxa.so${path}`,
      { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
      { WEB_ORIGIN: "https://doxa.so" },
    );
  };
  return { harness, send };
}

async function createTeam(send: ReturnType<typeof setup>["send"], name = "Acme Docs"): Promise<string> {
  const response = await send(OWNER, "/teams", "POST", { name });
  expect(response.status).toBe(201);
  return ((await response.json()) as { team: { id: string } }).team.id;
}

async function listTeams(send: ReturnType<typeof setup>["send"]): Promise<unknown[]> {
  return ((await (await send(OWNER, "/teams")).json()) as { teams: unknown[] }).teams;
}

describe("team.seats at invite create and accept (billing spec 9.3)", () => {
  test("on: a Free team cannot invite, and the answer is 403 plan_limit with the team's billing link", async () => {
    const { harness, send } = setup("on");
    const teamId = await createTeam(send);
    const response = await send(OWNER, `/teams/${teamId}/invites`, "POST", { role: "editor" });
    expect(response.status).toBe(403);
    const account = await harness.core.accounts.accountForOwner("team", teamId);
    const body = (await response.json()) as { error: { details: unknown } };
    expect(planLimitErrorDetailsSchema.parse(body.error.details)).toMatchObject({
      code: "plan_limit",
      key: "team.seats",
      limit: 1,
      used: 1,
      plan: "free",
      upgradeUrl: `https://doxa.so/dashboard/billing/${account.id}`,
    });
  });

  test("on: a Pro team invites; a later downgrade blocks the accept", async () => {
    const { harness, send } = setup("on");
    const teamId = await createTeam(send);
    const account = await harness.core.accounts.accountForOwner("team", teamId);
    await harness.billing.setSubscription(subscriptionFixture({ accountId: account.id }));
    const created = await send(OWNER, `/teams/${teamId}/invites`, "POST", { role: "editor" });
    expect(created.status).toBe(201);
    const token = new URL(((await created.json()) as { invite: { url: string } }).invite.url).pathname.split("/").pop() ?? "";

    await harness.billing.setSubscription(subscriptionFixture({ accountId: account.id, status: "canceled" }));
    expect((await send(MEMBER, `/team-invites/${token}/accept`, "POST")).status).toBe(403);
  });

  test("shadow and off: the invite works as before", async () => {
    for (const mode of ["shadow", "off"] as const) {
      const { send } = setup(mode);
      const teamId = await createTeam(send);
      const created = await send(OWNER, `/teams/${teamId}/invites`, "POST", { role: "editor" });
      expect(created.status).toBe(201);
      const token = new URL(((await created.json()) as { invite: { url: string } }).invite.url).pathname.split("/").pop() ?? "";
      expect((await send(MEMBER, `/team-invites/${token}/accept`, "POST")).status).toBe(200);
    }
  });
});

describe("one Free team per owner at team create (decided 2026-11-26)", () => {
  test("on: a Free user creates a first team, and the second answers 403 with the first team's billing link", async () => {
    const { harness, send } = setup("on");
    const firstTeamId = await createTeam(send);
    const response = await send(OWNER, "/teams", "POST", { name: "Second" });
    expect(response.status).toBe(403);
    const firstTeam = await harness.core.accounts.accountForOwner("team", firstTeamId);
    const body = (await response.json()) as { error: { details: unknown } };
    expect(planLimitErrorDetailsSchema.parse(body.error.details)).toEqual({
      code: "plan_limit",
      key: FREE_TEAMS_PER_OWNER_KEY,
      limit: 1,
      used: 1,
      plan: "free",
      resetsAt: null,
      upgradeUrl: `https://doxa.so/dashboard/billing/${firstTeam.id}`,
    });
    expect(await listTeams(send)).toHaveLength(1);
  });

  test("on: a paying customer creates teams with no limit: Pro on the first team", async () => {
    const { harness, send } = setup("on");
    const firstTeamId = await createTeam(send);
    const firstTeam = await harness.core.accounts.accountForOwner("team", firstTeamId);
    await harness.billing.setSubscription(subscriptionFixture({ accountId: firstTeam.id }));
    for (const name of ["Second", "Third", "Fourth"]) await createTeam(send, name);
    expect(await listTeams(send)).toHaveLength(4);
  });

  test("on: a paying customer creates teams with no limit: Pro on the personal account", async () => {
    const { harness, send } = setup("on");
    const personal = await harness.core.accounts.accountForOwner("user", OWNER);
    await harness.billing.setSubscription(subscriptionFixture({ accountId: personal.id }));
    for (const name of ["First", "Second", "Third"]) await createTeam(send, name);
    expect(await listTeams(send)).toHaveLength(3);
  });

  test("on: a trial on the first team frees its Free slot only", async () => {
    const { harness, send } = setup("on");
    const firstTeamId = await createTeam(send);
    const firstTeam = await harness.core.accounts.accountForOwner("team", firstTeamId);
    await harness.billing.setSubscription(subscriptionFixture({ accountId: firstTeam.id, status: "trialing" }));
    await createTeam(send, "Second");
    expect((await send(OWNER, "/teams", "POST", { name: "Third" })).status).toBe(403);
    expect(await listTeams(send)).toHaveLength(2);
  });

  test("shadow and off: a second Free team is created, as before billing", async () => {
    for (const mode of ["shadow", "off"] as const) {
      const { send } = setup(mode);
      await createTeam(send);
      await createTeam(send, "Second");
      expect(await listTeams(send)).toHaveLength(2);
    }
  });
});
