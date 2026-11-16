import type { BillingEnforcement } from "@doxahq/billing";
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

async function createTeam(send: ReturnType<typeof setup>["send"]): Promise<string> {
  const response = await send(OWNER, "/teams", "POST", { name: "Acme Docs" });
  return ((await response.json()) as { team: { id: string } }).team.id;
}

describe("team.seats at invite create and accept (billing spec 9.3)", () => {
  test("on: a Free team cannot invite, and the answer is 403 plan_limit", async () => {
    const { send } = setup("on");
    const teamId = await createTeam(send);
    const response = await send(OWNER, `/teams/${teamId}/invites`, "POST", { role: "editor" });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { details: unknown } };
    expect(planLimitErrorDetailsSchema.parse(body.error.details)).toMatchObject({ code: "plan_limit", key: "team.seats", limit: 1, used: 1 });
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
