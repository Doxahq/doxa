import {
  ROLE_CAPABILITIES,
  MAX_OWNED_TEAMS,
  TEAM_INVITE_EMAILS_PER_HOUR,
  TEAM_INVITE_EMAILS_PER_RECIPIENT_PER_DAY,
  TEAM_INVITE_EMAILS_PER_SENDER_PER_HOUR,
  TEAM_INVITE_TTL_DAYS,
  type AcceptedTeamInvite,
  type Capability,
  type CreateTeamInviteInput,
  type CreatedTeamInvite,
  type ProjectTeam,
  type TeamDetail,
  type TeamInvite,
  type TeamInvitePreview,
  type TeamRole,
  type TeamSummary,
} from "@doxahq/contracts/teams";
import { z } from "zod";
import type { Env } from "../../env";
import { TeamsRepository } from "../../repositories/teams";
import { dashboardActor } from "../agent-access/actor";
import { MembershipProjectAccessPolicy } from "../agent-access/membership-project-access-policy";
import { planSeamsFromEnv, type TeamSeatPolicy } from "../billing/plan-seams";
import type { ProjectAccessPolicy } from "../agent-access/project-access-policy";
import { OutboxTeamInviteMailer, type TeamInviteMailer } from "./invite-mailer";
import { HmacInviteTokens, hashInviteToken, isInviteToken, type InviteTokens } from "./invite-token";
import { TeamAccessError, TeamConflictError, TeamInviteError, TeamNotFoundError } from "./errors";
import type { MembershipChange, TeamInviteRecord, TeamStore } from "./team-store";

export interface TeamServiceDeps {
  readonly store: TeamStore;
  /** Checks the project side of a move: only the owner of a personal project moves it. */
  readonly projects: Pick<ProjectAccessPolicy, "authorize">;
  readonly now: () => Date;
  /** Derives each invite link's token from the invite ID. */
  readonly tokens: InviteTokens;
  readonly newId: () => string;
  /** Sends the link when the manager gives an email address. */
  readonly inviteMailer: TeamInviteMailer;
  /** Billing spec 9.3 `team.seats`, at invite create and accept. Absent: no seat limit. */
  readonly seats?: TeamSeatPolicy;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Shown as the inviter when the creator's account no longer has a name. */
const UNKNOWN_INVITER = "A Doxa member";

const idSchema = z.uuid();

/**
 * v2 spec §5: teams, members, roles and invite links. Every method takes the
 * signed-in user; a user who is not a member gets "not found" for the team.
 */
export class TeamService {
  constructor(private readonly deps: TeamServiceDeps) {}

  static fromEnv(env: Env): TeamService {
    return new TeamService({
      store: new TeamsRepository(env),
      projects: MembershipProjectAccessPolicy.fromEnv(env),
      now: () => new Date(),
      tokens: new HmacInviteTokens(env.BETTER_AUTH_SECRET),
      newId: () => crypto.randomUUID(),
      inviteMailer: OutboxTeamInviteMailer.fromEnv(env),
      seats: planSeamsFromEnv(env).teamSeats,
    });
  }

  async list(userId: string): Promise<TeamSummary[]> {
    const teams = await this.deps.store.listForUser(userId);
    return teams.map((team) => ({
      id: team.id,
      name: team.name,
      role: team.role,
      memberCount: team.memberCount,
      projectCount: team.projectCount,
      createdAt: team.createdAt.toISOString(),
    }));
  }

  /** The creator becomes the first owner. */
  async create(userId: string, name: string): Promise<TeamSummary> {
    // A soft limit (SEC-015): two requests at the same moment can both pass.
    if ((await this.deps.store.countOwnedTeams(userId)) >= MAX_OWNED_TEAMS) {
      throw new TeamConflictError(
        "team_limit",
        `You own ${MAX_OWNED_TEAMS} teams. Delete a team or leave its ownership before you create another.`,
      );
    }
    const team = await this.deps.store.create({ name, ownerUserId: userId, now: this.deps.now() });
    return {
      id: team.id,
      name: team.name,
      role: "owner",
      memberCount: 1,
      projectCount: 0,
      createdAt: team.createdAt.toISOString(),
    };
  }

  /** `webOrigin` builds the invite links, which only managers see. */
  async get(userId: string, teamId: string, webOrigin: string): Promise<TeamDetail> {
    const role = await this.roleOrNotFound(userId, teamId);
    const canManage = ROLE_CAPABILITIES[role].has("team.manage");
    const [team, members, invites, projects] = await Promise.all([
      this.deps.store.findTeam(teamId),
      this.deps.store.listMembers(teamId),
      canManage ? this.deps.store.listPendingInvites(teamId, this.deps.now()) : Promise.resolve([]),
      this.deps.store.listProjects(teamId),
    ]);
    if (team === null) throw new TeamNotFoundError();
    return {
      id: team.id,
      name: team.name,
      role,
      permissions: { manage: canManage, delete: ROLE_CAPABILITIES[role].has("team.delete") },
      members: members.map((member) => ({ ...member, joinedAt: member.joinedAt.toISOString() })),
      invites: await Promise.all(invites.map((invite) => this.toInvite(invite, webOrigin))),
      projects,
      createdAt: team.createdAt.toISOString(),
    };
  }

  async rename(userId: string, teamId: string, name: string): Promise<void> {
    await this.authorize(userId, teamId, "team.manage");
    await this.deps.store.rename(teamId, name, this.deps.now());
  }

  /** Refused while the team has projects: move or delete them first. */
  async delete(userId: string, teamId: string): Promise<void> {
    await this.authorize(userId, teamId, "team.delete");
    const result = await this.deps.store.delete(teamId);
    if (result.outcome === "not_found") throw new TeamNotFoundError();
    if (result.outcome === "has_projects") {
      throw new TeamConflictError("team_has_projects", "Move or delete the team's projects before you delete the team.");
    }
  }

  /**
   * The token is derived from the new invite ID; the store keeps only its SHA-256 hash.
   * With `input.email`, Doxa also sends the link to that address (email spec §10).
   */
  async createInvite(
    userId: string,
    teamId: string,
    input: CreateTeamInviteInput,
    webOrigin: string,
  ): Promise<CreatedTeamInvite> {
    const actorRole = await this.authorize(userId, teamId, "team.manage");
    assertMayGrant(actorRole, input.role);
    const now = this.deps.now();
    const invitedEmail = input.email?.trim().toLowerCase() ?? null;
    if (invitedEmail) await this.assertInviteEmailAllowed(teamId, userId, invitedEmail, now);
    await this.assertSeatForInvite(teamId, now);

    const id = this.deps.newId();
    const token = await this.deps.tokens.tokenFor(id);
    const invite = await this.deps.store.createInvite({
      id,
      teamId,
      tokenHash: await hashInviteToken(token),
      role: input.role,
      invitedEmail,
      createdByUserId: userId,
      expiresAt: new Date(now.getTime() + TEAM_INVITE_TTL_DAYS * DAY_MS),
      now,
    });
    const created = await this.toInvite(invite, webOrigin);
    if (invitedEmail && created.url) await this.sendInviteEmail(teamId, invite, invitedEmail, created.url);
    return { invite: created };
  }

  /**
   * Soft limits: two requests at the same moment can both pass a count.
   * Per team, per sender over all teams, and per recipient (SEC-015), so
   * that new teams cannot multiply the budget and no address gets flooded.
   */
  private async assertInviteEmailAllowed(teamId: string, userId: string, email: string, now: Date): Promise<void> {
    const hourAgo = new Date(now.getTime() - HOUR_MS);
    const [teamSent, senderSent, received] = await Promise.all([
      this.deps.store.countEmailedInvitesSince(teamId, hourAgo),
      this.deps.store.countEmailedInvitesBySenderSince(userId, hourAgo),
      this.deps.store.countEmailedInvitesToSince(userId, email, new Date(now.getTime() - DAY_MS)),
    ]);
    if (teamSent >= TEAM_INVITE_EMAILS_PER_HOUR) {
      throw new TeamConflictError(
        "invite_email_limit",
        `This team sent ${TEAM_INVITE_EMAILS_PER_HOUR} invites by email in the last hour. Try again later, or copy an invite link.`,
        429,
      );
    }
    if (senderSent >= TEAM_INVITE_EMAILS_PER_SENDER_PER_HOUR) {
      throw new TeamConflictError(
        "invite_sender_limit",
        `You sent ${TEAM_INVITE_EMAILS_PER_SENDER_PER_HOUR} invites by email in the last hour. Try again later, or copy an invite link.`,
        429,
      );
    }
    if (received >= TEAM_INVITE_EMAILS_PER_RECIPIENT_PER_DAY) {
      throw new TeamConflictError(
        "invite_recipient_limit",
        "You sent several invite emails to this address today. Copy an invite link and send it yourself.",
        429,
      );
    }
  }

  /**
   * Billing spec 9.3 `team.seats`: a new invite needs a seat for each member
   * and each pending invite, plus itself. A soft limit: two invites at the
   * same moment can both pass. The seat policy throws `PlanLimitError` (403)
   * with `BILLING_ENFORCEMENT=on` and only logs in `shadow`.
   */
  private async assertSeatForInvite(teamId: string, now: Date): Promise<void> {
    const seats = this.deps.seats;
    if (!seats?.active) return;
    const [members, invites] = await Promise.all([
      this.deps.store.listMembers(teamId),
      this.deps.store.listPendingInvites(teamId, now),
    ]);
    await seats.assertSeatAvailable({ teamId, used: members.length + invites.length });
  }

  /** At accept, the members count: a downgrade after the invite still blocks the join (spec 9.5). */
  private async assertSeatForAccept(userId: string, token: string): Promise<void> {
    const seats = this.deps.seats;
    if (!seats?.active) return;
    const invite = await this.deps.store.findInvite(await hashInviteToken(token));
    // A missing or unusable invite fails in `acceptInvite` with its own reason.
    if (invite === null || (await this.deps.store.findRole(invite.teamId, userId)) !== null) return;
    const members = await this.deps.store.listMembers(invite.teamId);
    await seats.assertSeatAvailable({ teamId: invite.teamId, used: members.length });
  }

  private async sendInviteEmail(teamId: string, invite: TeamInviteRecord, email: string, acceptUrl: string): Promise<void> {
    const team = await this.deps.store.findTeam(teamId);
    if (!team) throw new TeamNotFoundError();
    await this.deps.inviteMailer.send({
      inviteId: invite.id,
      email,
      props: {
        inviterName: invite.createdByName?.trim() || UNKNOWN_INVITER,
        teamName: team.name,
        role: invite.role,
        acceptUrl,
        expiresInDays: TEAM_INVITE_TTL_DAYS,
      },
    });
  }

  async revokeInvite(userId: string, teamId: string, inviteId: string): Promise<void> {
    await this.authorize(userId, teamId, "team.manage");
    if (!idSchema.safeParse(inviteId).success) throw new TeamNotFoundError();
    const revoked = await this.deps.store.revokeInvite(teamId, inviteId, this.deps.now());
    if (!revoked) throw new TeamNotFoundError();
  }

  /** What the accept page shows. A link that no longer works fails with its reason. */
  async previewInvite(userId: string, token: string): Promise<TeamInvitePreview> {
    const invite = isInviteToken(token) ? await this.deps.store.findInvite(await hashInviteToken(token)) : null;
    if (invite === null) throw new TeamInviteError("invite_not_found");
    if (invite.revokedAt !== null) throw new TeamInviteError("invite_revoked");
    if (invite.usedAt !== null) throw new TeamInviteError("invite_used");
    if (invite.expiresAt <= this.deps.now()) throw new TeamInviteError("invite_expired");
    if (invite.invitedEmail !== null && (await this.deps.store.findVerifiedEmail(userId)) !== invite.invitedEmail) {
      throw new TeamInviteError("invite_email_mismatch");
    }
    const role = await this.deps.store.findRole(invite.teamId, userId);
    return {
      teamName: invite.teamName,
      role: invite.role,
      expiresAt: invite.expiresAt.toISOString(),
      alreadyMember: role !== null,
    };
  }

  async acceptInvite(userId: string, token: string): Promise<AcceptedTeamInvite> {
    if (!isInviteToken(token)) throw new TeamInviteError("invite_not_found");
    await this.assertSeatForAccept(userId, token);
    const result = await this.deps.store.acceptInvite(await hashInviteToken(token), userId, this.deps.now());
    if (result.outcome !== "accepted") throw new TeamInviteError(result.outcome);
    return { teamId: result.teamId, role: result.role };
  }

  /** Only an owner gives or takes the owner role; one owner always stays. */
  async changeRole(userId: string, teamId: string, memberUserId: string, role: TeamRole): Promise<void> {
    const actorRole = await this.authorize(userId, teamId, "team.manage");
    const memberRole = await this.deps.store.findRole(teamId, memberUserId);
    if (memberRole === null) throw new TeamNotFoundError();
    assertMayGrant(actorRole, role);
    assertMayGrant(actorRole, memberRole);
    assertChanged(await this.deps.store.setRole(teamId, memberUserId, role, this.deps.now()));
  }

  /**
   * A member may leave; removing someone else needs `team.manage`, and an
   * owner only by an owner. The member's capabilities end at once: the
   * policy reads the membership on every call.
   */
  async removeMember(userId: string, teamId: string, memberUserId: string): Promise<void> {
    const actorRole = await this.roleOrNotFound(userId, teamId);
    if (memberUserId !== userId) {
      requireCapability(actorRole, "team.manage");
      const memberRole = await this.deps.store.findRole(teamId, memberUserId);
      if (memberRole === null) throw new TeamNotFoundError();
      assertMayGrant(actorRole, memberRole);
    }
    await this.assertOwnsNoTeamProject(teamId, memberUserId);
    assertChanged(await this.deps.store.removeMember(teamId, memberUserId));
  }

  /**
   * SEC-016 (owner decision 2026-10-30): a project keeps its owner when it
   * moves into a team, and the owner's GitHub installation and billing run
   * its generations. A member who still owns a team project cannot leave or
   * be removed: they would lose all access while the team kept using their
   * account.
   */
  private async assertOwnsNoTeamProject(teamId: string, memberUserId: string): Promise<void> {
    const owned = await this.deps.store.listProjectsOwnedBy(teamId, memberUserId);
    if (owned.length === 0) return;
    throw new TeamConflictError(
      "member_owns_projects",
      `This member still owns team projects: ${owned.map((project) => project.name).join(", ")}. Delete those projects first.`,
    );
  }

  /**
   * Spec §5: the owner of a personal project moves it into a team they
   * manage. The project keeps its owner (storage, billing, GitHub), so the
   * owner's agent grants keep working through the owner's team role.
   */
  /**
   * The team of a project that the user is about to create in it. Throws
   * "not found" for a team the user is not in, and "forbidden" for a role
   * without `project.create` (editor, viewer).
   */
  async authorizeProjectCreation(userId: string, teamId: string): Promise<ProjectTeam> {
    await this.authorize(userId, teamId, "project.create");
    const team = await this.deps.store.findTeam(teamId);
    if (team === null) throw new TeamNotFoundError();
    return { id: team.id, name: team.name };
  }

  async moveProject(userId: string, projectId: string, teamId: string): Promise<void> {
    const decision = await this.deps.projects.authorize(dashboardActor(userId), projectId, "project.delete");
    if (!decision.allowed) {
      if (decision.reason === "forbidden") throw new TeamAccessError();
      throw new TeamNotFoundError();
    }
    if (decision.project.ownerUserId !== userId) throw new TeamAccessError();
    await this.authorize(userId, teamId, "team.manage");
    const result = await this.deps.store.moveProject(decision.project.projectId, teamId, this.deps.now());
    if (result.outcome === "not_found") throw new TeamNotFoundError();
    if (result.outcome === "already_in_team") {
      throw new TeamConflictError("project_in_team", "This project is already in a team.");
    }
  }

  private async toInvite(invite: TeamInviteRecord, webOrigin: string): Promise<TeamInvite> {
    return {
      id: invite.id,
      url: await this.inviteUrl(invite, webOrigin),
      email: invite.invitedEmail,
      role: invite.role,
      createdBy:
        invite.createdByUserId !== null && invite.createdByName !== null
          ? { userId: invite.createdByUserId, name: invite.createdByName }
          : null,
      createdAt: invite.createdAt.toISOString(),
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  /** Null for an older invite made with a random token: its link cannot be rebuilt. */
  private async inviteUrl(invite: TeamInviteRecord, webOrigin: string): Promise<string | null> {
    const token = await this.deps.tokens.tokenFor(invite.id);
    if ((await hashInviteToken(token)) !== invite.tokenHash) return null;
    return `${webOrigin}/invite/${token}`;
  }

  private async roleOrNotFound(userId: string, teamId: string): Promise<TeamRole> {
    if (!idSchema.safeParse(teamId).success) throw new TeamNotFoundError();
    const role = await this.deps.store.findRole(teamId, userId);
    if (role === null) throw new TeamNotFoundError();
    return role;
  }

  private async authorize(userId: string, teamId: string, capability: Capability): Promise<TeamRole> {
    const role = await this.roleOrNotFound(userId, teamId);
    requireCapability(role, capability);
    return role;
  }
}

function requireCapability(role: TeamRole, capability: Capability): void {
  if (!ROLE_CAPABILITIES[role].has(capability)) throw new TeamAccessError();
}

/** Only owners grant, take or touch the owner role. */
function assertMayGrant(actorRole: TeamRole, role: TeamRole): void {
  if (role === "owner" && actorRole !== "owner") {
    throw new TeamConflictError("owner_role_required", "Only an owner can give or change the owner role.", 403);
  }
}

function assertChanged(change: MembershipChange): void {
  if (change.outcome === "not_member") throw new TeamNotFoundError();
  if (change.outcome === "last_owner") {
    throw new TeamConflictError("last_owner", "A team needs at least one owner. Make another member an owner first.");
  }
}
