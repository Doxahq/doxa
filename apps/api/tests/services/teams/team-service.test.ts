import { describe, expect, it } from "vitest";
import { TEAM_INVITE_EMAILS_PER_HOUR, type TeamRole } from "@doxahq/contracts/teams";
import { dashboardActor, agentActor } from "../../../src/services/agent-access/actor";
import { MembershipProjectAccessPolicy } from "../../../src/services/agent-access/membership-project-access-policy";
import {
  TeamAccessError,
  TeamConflictError,
  TeamInviteError,
  TeamNotFoundError,
} from "../../../src/services/teams/errors";
import { HmacInviteTokens, hashInviteToken, isInviteToken } from "../../../src/services/teams/invite-token";
import { TeamService } from "../../../src/services/teams/team-service";
import { InMemoryProjectAccess } from "../../support/in-memory-project-access";
import { InMemoryTeamStore } from "../../support/in-memory-team-store";
import { RecordingInviteMailer } from "../../support/recording-invite-mailer";

const OWNER = "owner-1";
const ADMIN = "admin-1";
const EDITOR = "editor-1";
const VIEWER = "viewer-1";
const NEWCOMER = "newcomer-1";
const PERSONAL = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "https://doxa.so";
const SECRET = "test-auth-secret";
const INVITE_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const DAY = 24 * 60 * 60 * 1000;

function setup() {
  let clock = new Date("2026-10-05T10:00:00Z").getTime();
  let ids = 0;
  const access = new InMemoryProjectAccess({ [PERSONAL]: { owner: ADMIN } });
  const store = new InMemoryTeamStore(access, { [OWNER]: "Olivia", [ADMIN]: "Ada" });
  const inviteMailer = new RecordingInviteMailer();
  const service = new TeamService({
    store,
    projects: new MembershipProjectAccessPolicy(access),
    now: () => new Date(clock),
    tokens: new HmacInviteTokens(SECRET),
    newId: () => `aaaaaaaa-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    inviteMailer,
  });
  const advance = (ms: number) => {
    clock += ms;
  };
  return { access, store, service, advance, inviteMailer };
}

/** A team with one member of each role. */
async function team(env: ReturnType<typeof setup>) {
  const created = await env.service.create(OWNER, "Acme Docs");
  const members: [string, TeamRole][] = [
    [ADMIN, "admin"],
    [EDITOR, "editor"],
    [VIEWER, "viewer"],
  ];
  for (const [userId, role] of members) env.access.join(created.id, userId, role);
  return created.id;
}

function tokenOf(url: string | null): string {
  if (url === null) throw new Error("The invite has no link.");
  return url.slice(`${ORIGIN}/invite/`.length);
}

describe("invite tokens", () => {
  it("are 43 base64url characters derived from the invite ID and the secret", async () => {
    const tokens = new HmacInviteTokens(SECRET);
    const token = await tokens.tokenFor(INVITE_ID);
    expect(isInviteToken(token)).toBe(true);
    await expect(tokens.tokenFor(INVITE_ID)).resolves.toBe(token);
    await expect(new HmacInviteTokens(SECRET).tokenFor(INVITE_ID)).resolves.toBe(token);
    await expect(tokens.tokenFor("aaaaaaaa-0000-4000-8000-000000000002")).resolves.not.toBe(token);
    await expect(new HmacInviteTokens("another-secret").tokenFor(INVITE_ID)).resolves.not.toBe(token);
  });

  it("are hashed with SHA-256, and a malformed token is refused", async () => {
    expect(await hashInviteToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(isInviteToken("../../etc")).toBe(false);
  });
});

describe("teams", () => {
  it("makes the creator the first owner and lists the team with the role", async () => {
    const env = setup();
    const created = await env.service.create(OWNER, "Acme Docs");
    expect(created).toMatchObject({ name: "Acme Docs", role: "owner", memberCount: 1, projectCount: 0 });
    await expect(env.service.list(OWNER)).resolves.toEqual([expect.objectContaining({ id: created.id, role: "owner" })]);
    await expect(env.service.list(VIEWER)).resolves.toEqual([]);
  });

  it("answers not found to a non-member and to a malformed ID", async () => {
    const env = setup();
    const teamId = await team(env);
    await expect(env.service.get(NEWCOMER, teamId, ORIGIN)).rejects.toBeInstanceOf(TeamNotFoundError);
    await expect(env.service.get(OWNER, "not-a-uuid", ORIGIN)).rejects.toBeInstanceOf(TeamNotFoundError);
  });

  it("shows invites and permissions only to the roles that have them", async () => {
    const env = setup();
    const teamId = await team(env);
    await env.service.createInvite(OWNER, teamId, { role: "editor" }, ORIGIN);
    const asOwner = await env.service.get(OWNER, teamId, ORIGIN);
    expect(asOwner.permissions).toEqual({ manage: true, delete: true });
    expect(asOwner.invites).toHaveLength(1);
    const asAdmin = await env.service.get(ADMIN, teamId, ORIGIN);
    expect(asAdmin.permissions).toEqual({ manage: true, delete: false });
    const asViewer = await env.service.get(VIEWER, teamId, ORIGIN);
    expect(asViewer.permissions).toEqual({ manage: false, delete: false });
    expect(asViewer.invites).toEqual([]);
    expect(asViewer.members.map((member) => member.role).sort()).toEqual(["admin", "editor", "owner", "viewer"]);
  });

  it("renames with team.manage only", async () => {
    const env = setup();
    const teamId = await team(env);
    await expect(env.service.rename(EDITOR, teamId, "X")).rejects.toBeInstanceOf(TeamAccessError);
    await env.service.rename(ADMIN, teamId, "Acme");
    await expect(env.service.get(VIEWER, teamId, ORIGIN)).resolves.toMatchObject({ name: "Acme" });
  });

  it("deletes with team.delete only, and never while the team has projects", async () => {
    const env = setup();
    const teamId = await team(env);
    await env.service.moveProject(ADMIN, PERSONAL, teamId);
    await expect(env.service.delete(ADMIN, teamId)).rejects.toBeInstanceOf(TeamAccessError);
    await expect(env.service.delete(OWNER, teamId)).rejects.toMatchObject({ code: "team_has_projects" });
    env.access.projects.delete(PERSONAL);
    await env.service.delete(OWNER, teamId);
    await expect(env.service.get(OWNER, teamId, ORIGIN)).rejects.toBeInstanceOf(TeamNotFoundError);
  });
});

describe("invite links", () => {
  it("stores only the SHA-256 hash of the token in the link", async () => {
    const env = setup();
    const teamId = await team(env);
    const { invite } = await env.service.createInvite(ADMIN, teamId, { role: "editor" }, ORIGIN);
    const token = tokenOf(invite.url);
    expect(invite.id).toBe(INVITE_ID);
    expect(token).toBe(await new HmacInviteTokens(SECRET).tokenFor(INVITE_ID));
    expect(env.store.invites).toHaveLength(1);
    expect(env.store.invites[0]?.tokenHash).toBe(await hashInviteToken(token));
    expect(JSON.stringify(env.store.invites)).not.toContain(token);
    expect(invite).toMatchObject({ role: "editor", createdBy: { userId: ADMIN, name: "Ada" } });
    expect(Date.parse(invite.expiresAt) - Date.parse(invite.createdAt)).toBe(7 * DAY);
  });

  it("shows the team and the role before accepting, then joins the team once", async () => {
    const env = setup();
    const teamId = await team(env);
    const token = tokenOf((await env.service.createInvite(ADMIN, teamId, { role: "editor" }, ORIGIN)).invite.url);
    await expect(env.service.previewInvite(NEWCOMER, token)).resolves.toMatchObject({
      teamName: "Acme Docs",
      role: "editor",
      alreadyMember: false,
    });
    await expect(env.service.acceptInvite(NEWCOMER, token)).resolves.toEqual({ teamId, role: "editor" });
    await expect(env.service.get(NEWCOMER, teamId, ORIGIN)).resolves.toMatchObject({ role: "editor" });
    // Single use: the same link fails for anyone afterwards.
    await expect(env.service.acceptInvite("someone-else", token)).rejects.toMatchObject({ code: "invite_used" });
    await expect(env.service.previewInvite("someone-else", token)).rejects.toMatchObject({ code: "invite_used" });
  });

  it("expires after 7 days", async () => {
    const env = setup();
    const teamId = await team(env);
    const token = tokenOf((await env.service.createInvite(ADMIN, teamId, { role: "viewer" }, ORIGIN)).invite.url);
    env.advance(7 * DAY);
    await expect(env.service.acceptInvite(NEWCOMER, token)).rejects.toMatchObject({ code: "invite_expired" });
    await expect(env.service.get(OWNER, teamId, ORIGIN)).resolves.toMatchObject({ invites: [] });
  });

  it("fails cleanly once revoked, and lists only pending invites", async () => {
    const env = setup();
    const teamId = await team(env);
    const created = await env.service.createInvite(ADMIN, teamId, { role: "viewer" }, ORIGIN);
    await expect(env.service.revokeInvite(EDITOR, teamId, created.invite.id)).rejects.toBeInstanceOf(TeamAccessError);
    await env.service.revokeInvite(ADMIN, teamId, created.invite.id);
    await expect(env.service.acceptInvite(NEWCOMER, tokenOf(created.invite.url))).rejects.toMatchObject({
      code: "invite_revoked",
    });
    await expect(env.service.revokeInvite(ADMIN, teamId, created.invite.id)).rejects.toBeInstanceOf(TeamNotFoundError);
    await expect(env.service.get(ADMIN, teamId, ORIGIN)).resolves.toMatchObject({ invites: [] });
  });

  it("lists each pending invite with the same link that was created", async () => {
    const env = setup();
    const teamId = await team(env);
    const { invite } = await env.service.createInvite(ADMIN, teamId, { role: "editor" }, ORIGIN);
    const { invites } = await env.service.get(OWNER, teamId, ORIGIN);
    expect(invites).toEqual([invite]);
    await expect(env.service.previewInvite(NEWCOMER, tokenOf(invites[0]?.url ?? null))).resolves.toMatchObject({
      role: "editor",
    });
  });

  it("lists an older invite made with a random token without a link", async () => {
    const env = setup();
    const teamId = await team(env);
    const randomToken = "r".repeat(43);
    await env.store.createInvite({
      id: "bbbbbbbb-0000-4000-8000-000000000001",
      teamId,
      tokenHash: await hashInviteToken(randomToken),
      role: "viewer",
      invitedEmail: null,
      createdByUserId: OWNER,
      expiresAt: new Date("2026-10-12T10:00:00Z"),
      now: new Date("2026-10-05T10:00:00Z"),
    });
    await expect(env.service.get(OWNER, teamId, ORIGIN)).resolves.toMatchObject({
      invites: [{ id: "bbbbbbbb-0000-4000-8000-000000000001", url: null }],
    });
    // The link the creator kept still works.
    await expect(env.service.previewInvite(NEWCOMER, randomToken)).resolves.toMatchObject({ role: "viewer" });
  });

  it("answers invite_not_found to an unknown or malformed token", async () => {
    const env = setup();
    await team(env);
    await expect(env.service.acceptInvite(NEWCOMER, "b".repeat(43))).rejects.toMatchObject({ code: "invite_not_found" });
    await expect(env.service.previewInvite(NEWCOMER, "short")).rejects.toBeInstanceOf(TeamInviteError);
  });

  it("keeps the link unused when a member opens it", async () => {
    const env = setup();
    const teamId = await team(env);
    const token = tokenOf((await env.service.createInvite(ADMIN, teamId, { role: "admin" }, ORIGIN)).invite.url);
    await expect(env.service.previewInvite(VIEWER, token)).resolves.toMatchObject({ alreadyMember: true });
    await expect(env.service.acceptInvite(VIEWER, token)).rejects.toMatchObject({ code: "already_member" });
    // The viewer did not get the admin role, and the link still works for a newcomer.
    await expect(env.service.get(VIEWER, teamId, ORIGIN)).resolves.toMatchObject({ role: "viewer" });
    await expect(env.service.acceptInvite(NEWCOMER, token)).resolves.toMatchObject({ role: "admin" });
  });

  it("needs team.manage to create a link, and the owner role to invite an owner", async () => {
    const env = setup();
    const teamId = await team(env);
    await expect(env.service.createInvite(EDITOR, teamId, { role: "viewer" }, ORIGIN)).rejects.toBeInstanceOf(TeamAccessError);
    await expect(env.service.createInvite(VIEWER, teamId, { role: "viewer" }, ORIGIN)).rejects.toBeInstanceOf(TeamAccessError);
    await expect(env.service.createInvite(ADMIN, teamId, { role: "owner" }, ORIGIN)).rejects.toMatchObject({
      code: "owner_role_required",
    });
    await expect(env.service.createInvite(OWNER, teamId, { role: "owner" }, ORIGIN)).resolves.toMatchObject({
      invite: { role: "owner" },
    });
    await expect(env.service.createInvite(NEWCOMER, teamId, { role: "viewer" }, ORIGIN)).rejects.toBeInstanceOf(TeamNotFoundError);
  });
});

describe("members and roles", () => {
  it("never removes or demotes the last owner", async () => {
    const env = setup();
    const teamId = await team(env);
    await expect(env.service.changeRole(OWNER, teamId, OWNER, "admin")).rejects.toMatchObject({ code: "last_owner" });
    await expect(env.service.removeMember(OWNER, teamId, OWNER)).rejects.toMatchObject({ code: "last_owner" });
    await env.service.changeRole(OWNER, teamId, ADMIN, "owner");
    // With a second owner, the first one can step down or leave.
    await env.service.changeRole(OWNER, teamId, OWNER, "admin");
    await expect(env.service.get(ADMIN, teamId, ORIGIN)).resolves.toMatchObject({ role: "owner" });
  });

  it("lets only an owner give, take or change the owner role", async () => {
    const env = setup();
    const teamId = await team(env);
    await expect(env.service.changeRole(ADMIN, teamId, EDITOR, "owner")).rejects.toMatchObject({
      code: "owner_role_required",
    });
    await expect(env.service.changeRole(ADMIN, teamId, OWNER, "viewer")).rejects.toBeInstanceOf(TeamConflictError);
    await expect(env.service.removeMember(ADMIN, teamId, OWNER)).rejects.toMatchObject({ code: "owner_role_required" });
    await env.service.changeRole(ADMIN, teamId, EDITOR, "viewer");
    await expect(env.service.get(EDITOR, teamId, ORIGIN)).resolves.toMatchObject({ role: "viewer" });
  });

  it("needs team.manage to change roles or remove someone else", async () => {
    const env = setup();
    const teamId = await team(env);
    await expect(env.service.changeRole(EDITOR, teamId, VIEWER, "editor")).rejects.toBeInstanceOf(TeamAccessError);
    await expect(env.service.removeMember(EDITOR, teamId, VIEWER)).rejects.toBeInstanceOf(TeamAccessError);
    await expect(env.service.changeRole(ADMIN, teamId, NEWCOMER, "viewer")).rejects.toBeInstanceOf(TeamNotFoundError);
  });

  it("lets a member leave, which ends their project access at once", async () => {
    const env = setup();
    const teamId = await team(env);
    await env.service.moveProject(ADMIN, PERSONAL, teamId);
    const policy = new MembershipProjectAccessPolicy(env.access);
    expect((await policy.authorize(dashboardActor(VIEWER), PERSONAL, "docs.read")).allowed).toBe(true);
    await env.service.removeMember(VIEWER, teamId, VIEWER);
    await expect(policy.authorize(dashboardActor(VIEWER), PERSONAL, "docs.read")).resolves.toEqual({
      allowed: false,
      reason: "not_found",
    });
    await expect(env.service.get(VIEWER, teamId, ORIGIN)).rejects.toBeInstanceOf(TeamNotFoundError);
  });
});

describe("moving a project into a team", () => {
  it("moves the owner's personal project into a team they manage; their grants keep working", async () => {
    const env = setup();
    const teamId = await team(env);
    const policy = new MembershipProjectAccessPolicy(env.access);
    const grant = agentActor({
      userId: ADMIN,
      clientId: "client-1",
      clientName: "Claude Code",
      grantRef: "22222222-2222-4222-8222-222222222222",
      scopes: ["docs:write"],
      projectScope: { kind: "selected", projectIds: [PERSONAL] },
    });
    await env.service.moveProject(ADMIN, PERSONAL, teamId);
    await expect(env.service.get(EDITOR, teamId, ORIGIN)).resolves.toMatchObject({ projects: [{ id: PERSONAL }] });
    expect((await policy.authorize(grant, PERSONAL, "docs.write")).allowed).toBe(true);
    expect((await policy.authorize(dashboardActor(EDITOR), PERSONAL, "docs.write")).allowed).toBe(true);
  });

  it("refuses a team the owner cannot manage, someone else's project, and a team project", async () => {
    const env = setup();
    const teamId = await team(env);
    const editorTeam = await env.service.create(OWNER, "Other");
    env.access.join(editorTeam.id, ADMIN, "editor");
    await expect(env.service.moveProject(ADMIN, PERSONAL, editorTeam.id)).rejects.toBeInstanceOf(TeamAccessError);
    await expect(env.service.moveProject(OWNER, PERSONAL, teamId)).rejects.toBeInstanceOf(TeamNotFoundError);
    await env.service.moveProject(ADMIN, PERSONAL, teamId);
    // Now a team project: only its team owner role has project.delete, and it is not personal any more.
    env.access.join(teamId, ADMIN, "owner");
    await expect(env.service.moveProject(ADMIN, PERSONAL, teamId)).rejects.toMatchObject({ code: "project_in_team" });
  });
});

describe("invites by email", () => {
  it("sends the invite link to the address and lists it with the invite", async () => {
    const env = setup();
    const teamId = await team(env);

    const { invite } = await env.service.createInvite(ADMIN, teamId, { role: "editor", email: " Grace@Example.com " }, ORIGIN);

    expect(invite.email).toBe("grace@example.com");
    expect(env.inviteMailer.sent).toEqual([
      {
        inviteId: invite.id,
        email: "grace@example.com",
        props: {
          inviterName: "Ada",
          teamName: "Acme Docs",
          role: "editor",
          acceptUrl: invite.url,
          expiresInDays: 7,
        },
      },
    ]);
    await expect(env.service.get(ADMIN, teamId, ORIGIN)).resolves.toMatchObject({
      invites: [{ id: invite.id, email: "grace@example.com" }],
    });
  });

  it("sends nothing for an invite link without an address", async () => {
    const env = setup();
    const teamId = await team(env);

    const { invite } = await env.service.createInvite(ADMIN, teamId, { role: "viewer" }, ORIGIN);

    expect(invite.email).toBeNull();
    expect(env.inviteMailer.sent).toHaveLength(0);
  });

  it("limits invites by email for each team in one hour, but not invite links", async () => {
    const env = setup();
    const teamId = await team(env);
    for (let index = 0; index < TEAM_INVITE_EMAILS_PER_HOUR; index += 1) {
      await env.service.createInvite(ADMIN, teamId, { role: "viewer", email: `user${index}@example.com` }, ORIGIN);
    }

    await expect(
      env.service.createInvite(ADMIN, teamId, { role: "viewer", email: "late@example.com" }, ORIGIN),
    ).rejects.toMatchObject({ code: "invite_email_limit", status: 429 });
    await expect(env.service.createInvite(ADMIN, teamId, { role: "viewer" }, ORIGIN)).resolves.toBeDefined();

    env.advance(60 * 60 * 1000);
    await expect(
      env.service.createInvite(ADMIN, teamId, { role: "viewer", email: "late@example.com" }, ORIGIN),
    ).resolves.toBeDefined();
  });

  it("checks the role before it sends anything", async () => {
    const env = setup();
    const teamId = await team(env);

    await expect(
      env.service.createInvite(EDITOR, teamId, { role: "viewer", email: "x@example.com" }, ORIGIN),
    ).rejects.toBeInstanceOf(TeamAccessError);
    expect(env.inviteMailer.sent).toHaveLength(0);
  });
});
