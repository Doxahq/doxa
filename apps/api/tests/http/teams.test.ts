import { TEAM_INVITE_EMAILS_PER_HOUR, createdTeamInviteSchema, teamDetailSchema } from "@doxahq/contracts/teams";
import { describe, expect, test, vi } from "vitest";
import { createApiRouter } from "../../src/http/app";
import { MembershipProjectAccessPolicy } from "../../src/services/agent-access/membership-project-access-policy";
import { HmacInviteTokens } from "../../src/services/teams/invite-token";
import { TeamService } from "../../src/services/teams/team-service";
import { InMemoryProjectAccess } from "../support/in-memory-project-access";
import { InMemoryTeamStore } from "../support/in-memory-team-store";
import { RecordingInviteMailer } from "../support/recording-invite-mailer";

const session = vi.hoisted(() => ({ userId: "owner-1" }));
vi.mock("../../src/http/auth", () => ({
  withUser: (_context: unknown, handler: (userId: string) => Promise<Response>) => handler(session.userId),
}));
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const { createProjectTeamRoutes, createTeamInviteRoutes, createTeamRoutes } = await import("../../src/routes/teams");

const OWNER = "owner-1";
const MEMBER = "member-1";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const INVITE_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const SECRET = "test-auth-secret";

function setup() {
  const access = new InMemoryProjectAccess({ [PROJECT]: { owner: OWNER } });
  const store = new InMemoryTeamStore(access, { [OWNER]: "Olivia" });
  const service = new TeamService({
    store,
    projects: new MembershipProjectAccessPolicy(access),
    now: () => new Date("2026-10-05T10:00:00Z"),
    tokens: new HmacInviteTokens(SECRET),
    newId: () => INVITE_ID,
    inviteMailer: new RecordingInviteMailer(),
  });
  const app = createApiRouter();
  app.route("/teams", createTeamRoutes(() => service));
  app.route("/team-invites", createTeamInviteRoutes(() => service));
  app.route("/projects/:projectId/team", createProjectTeamRoutes(() => service));
  const send = (userId: string, path: string, method = "GET", body?: unknown) => {
    session.userId = userId;
    return app.request(`https://api.doxa.so${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, { WEB_ORIGIN: "https://doxa.so" });
  };
  return { access, store, send };
}

async function createTeam(env: ReturnType<typeof setup>): Promise<string> {
  const response = await env.send(OWNER, "/teams", "POST", { name: "Acme Docs" });
  expect(response.status).toBe(201);
  const { team } = (await response.json()) as { team: { id: string } };
  return team.id;
}

describe("team routes", () => {
  test("create, list and read a team; 404 for a non-member", async () => {
    const env = setup();
    const teamId = await createTeam(env);
    await expect((await env.send(OWNER, "/teams")).json()).resolves.toMatchObject({
      teams: [{ id: teamId, name: "Acme Docs", role: "owner" }],
    });
    expect((await env.send(MEMBER, `/teams/${teamId}`)).status).toBe(404);
    expect((await env.send(OWNER, "/teams", "POST", { name: "  " })).status).toBe(400);
  });

  test("an invite link joins the team once; a reused link answers 410", async () => {
    const env = setup();
    const teamId = await createTeam(env);
    const created = await env.send(OWNER, `/teams/${teamId}/invites`, "POST", { role: "editor" });
    expect(created.status).toBe(201);
    const { invite } = createdTeamInviteSchema.parse(await created.json());
    const token = await new HmacInviteTokens(SECRET).tokenFor(INVITE_ID);
    expect(invite.url).toBe(`https://doxa.so/invite/${token}`);
    // The team detail lists the pending invite with the same link.
    const detail = teamDetailSchema.parse(await (await env.send(OWNER, `/teams/${teamId}`)).json());
    expect(detail.invites).toEqual([invite]);

    const preview = await env.send(MEMBER, `/team-invites/${token}`);
    expect(await preview.json()).toMatchObject({ teamName: "Acme Docs", role: "editor", alreadyMember: false });
    const accepted = await env.send(MEMBER, `/team-invites/${token}/accept`, "POST");
    expect(await accepted.json()).toEqual({ teamId, role: "editor" });

    const reused = await env.send("someone-else", `/team-invites/${token}/accept`, "POST");
    expect(reused.status).toBe(410);
    expect(await reused.json()).toMatchObject({ error: { details: { code: "invite_used" } } });
    expect((await env.send(MEMBER, "/team-invites/unknown/accept", "POST")).status).toBe(404);
  });

  test("maps team rules to clean status codes", async () => {
    const env = setup();
    const teamId = await createTeam(env);
    env.access.join(teamId, MEMBER, "editor");
    const demoteLast = await env.send(OWNER, `/teams/${teamId}/members/${OWNER}`, "PATCH", { role: "admin" });
    expect(demoteLast.status).toBe(409);
    expect(await demoteLast.json()).toMatchObject({ error: { details: { code: "last_owner" } } });
    const editorInvite = await env.send(MEMBER, `/teams/${teamId}/invites`, "POST", { role: "viewer" });
    expect(editorInvite.status).toBe(403);
    expect((await env.send(MEMBER, `/teams/${teamId}`, "DELETE")).status).toBe(403);
    expect((await env.send(MEMBER, `/teams/${teamId}/members/${MEMBER}`, "DELETE")).status).toBe(204);
  });

  test("sends an invite by email, refuses a bad address, and answers 429 over the hourly limit", async () => {
    const env = setup();
    const teamId = await createTeam(env);

    const created = await env.send(OWNER, `/teams/${teamId}/invites`, "POST", { role: "editor", email: "grace@example.com" });
    expect(created.status).toBe(201);
    expect(createdTeamInviteSchema.parse(await created.json()).invite.email).toBe("grace@example.com");
    expect((await env.send(OWNER, `/teams/${teamId}/invites`, "POST", { role: "editor", email: "nope" })).status).toBe(400);

    for (let index = 1; index < TEAM_INVITE_EMAILS_PER_HOUR; index += 1) {
      await env.store.createInvite({
        id: `bbbbbbbb-0000-4000-8000-${String(index).padStart(12, "0")}`,
        teamId,
        tokenHash: `hash-${index}`,
        role: "viewer",
        invitedEmail: `user${index}@example.com`,
        createdByUserId: OWNER,
        expiresAt: new Date("2026-10-12T10:00:00Z"),
        now: new Date("2026-10-05T09:30:00Z"),
      });
    }
    const limited = await env.send(OWNER, `/teams/${teamId}/invites`, "POST", { role: "editor", email: "late@example.com" });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { details: { code: "invite_email_limit" } } });
  });

  test("moves the owner's project into a team, and blocks deleting a team with projects", async () => {
    const env = setup();
    const teamId = await createTeam(env);
    const moved = await env.send(OWNER, `/projects/${PROJECT}/team`, "PUT", { teamId });
    expect(moved.status).toBe(200);
    expect(env.access.projects.get(PROJECT)?.teamId).toBe(teamId);
    const again = await env.send(OWNER, `/projects/${PROJECT}/team`, "PUT", { teamId });
    expect(again.status).toBe(409);
    const deleted = await env.send(OWNER, `/teams/${teamId}`, "DELETE");
    expect(deleted.status).toBe(409);
    expect(await deleted.json()).toMatchObject({ error: { details: { code: "team_has_projects" } } });
    expect((await env.send(MEMBER, `/projects/${PROJECT}/team`, "PUT", { teamId })).status).toBe(404);
  });
});
