import type { TeamProject, TeamRole } from "@doxahq/contracts/teams";
import { and, asc, count, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { createDb, schema, type DbEnv, type DoxaDb } from "@doxahq/db";
import type {
  InviteAcceptance,
  InviteLookup,
  MembershipChange,
  NewTeamInvite,
  ProjectMove,
  TeamDeletion,
  TeamInviteRecord,
  TeamMemberRecord,
  TeamRecord,
  TeamStore,
  TeamSummaryRecord,
} from "../services/teams/team-store";

type Tx = Parameters<Parameters<DoxaDb["transaction"]>[0]>[0];

const { teams, teamMembers, teamInvites, projects } = schema;

export class TeamsRepository implements TeamStore {
  private readonly db: DoxaDb;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  async listForUser(userId: string): Promise<TeamSummaryRecord[]> {
    const memberCount = sql<number>`(select count(*) from ${teamMembers} as m where m.team_id = ${teams.id})`.mapWith(Number);
    const projectCount = sql<number>`(select count(*) from ${projects} as p where p.team_id = ${teams.id})`.mapWith(Number);
    return this.db
      .select({
        id: teams.id,
        name: teams.name,
        createdAt: teams.createdAt,
        role: teamMembers.role,
        memberCount,
        projectCount,
      })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(eq(teamMembers.userId, userId))
      .orderBy(asc(teams.name), asc(teams.createdAt));
  }

  async findTeam(teamId: string): Promise<TeamRecord | null> {
    const [row] = await this.db
      .select({ id: teams.id, name: teams.name, createdAt: teams.createdAt })
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);
    return row ?? null;
  }

  findRole(teamId: string, userId: string): Promise<TeamRole | null> {
    return findRole(this.db, teamId, userId);
  }

  listMembers(teamId: string): Promise<TeamMemberRecord[]> {
    return this.db
      .select({
        userId: teamMembers.userId,
        name: schema.user.name,
        email: schema.user.email,
        image: schema.user.image,
        role: teamMembers.role,
        joinedAt: teamMembers.createdAt,
      })
      .from(teamMembers)
      .innerJoin(schema.user, eq(schema.user.id, teamMembers.userId))
      .where(eq(teamMembers.teamId, teamId))
      .orderBy(asc(teamMembers.createdAt));
  }

  listPendingInvites(teamId: string, now: Date): Promise<TeamInviteRecord[]> {
    return this.db
      .select({
        id: teamInvites.id,
        tokenHash: teamInvites.tokenHash,
        role: teamInvites.role,
        invitedEmail: teamInvites.invitedEmail,
        createdByUserId: teamInvites.createdByUserId,
        createdByName: schema.user.name,
        createdAt: teamInvites.createdAt,
        expiresAt: teamInvites.expiresAt,
      })
      .from(teamInvites)
      .leftJoin(schema.user, eq(schema.user.id, teamInvites.createdByUserId))
      .where(and(eq(teamInvites.teamId, teamId), pendingInvite(now)))
      .orderBy(asc(teamInvites.createdAt));
  }

  listProjectsOwnedBy(teamId: string, userId: string): Promise<TeamProject[]> {
    return this.db
      .select({ id: projects.id, name: projects.name, slug: projects.slug })
      .from(projects)
      .where(and(eq(projects.teamId, teamId), eq(projects.userId, userId)))
      .orderBy(asc(projects.name));
  }

  listProjects(teamId: string): Promise<TeamProject[]> {
    return this.db
      .select({ id: projects.id, name: projects.name, slug: projects.slug })
      .from(projects)
      .where(eq(projects.teamId, teamId))
      .orderBy(asc(projects.name));
  }

  create(input: { name: string; ownerUserId: string; now: Date }): Promise<TeamRecord> {
    return this.db.transaction(async (tx) => {
      const [team] = await tx
        .insert(teams)
        .values({ name: input.name, createdAt: input.now, updatedAt: input.now })
        .returning({ id: teams.id, name: teams.name, createdAt: teams.createdAt });
      await tx.insert(teamMembers).values({
        teamId: team.id,
        userId: input.ownerUserId,
        role: "owner",
        createdAt: input.now,
        updatedAt: input.now,
      });
      return team;
    });
  }

  async rename(teamId: string, name: string, now: Date): Promise<void> {
    await this.db.update(teams).set({ name, updatedAt: now }).where(eq(teams.id, teamId));
  }

  delete(teamId: string): Promise<TeamDeletion> {
    return this.db.transaction(async (tx) => {
      if (!(await lockTeam(tx, teamId))) return { outcome: "not_found" };
      const [projectRows] = await tx
        .select({ value: count() })
        .from(projects)
        .where(eq(projects.teamId, teamId));
      // The foreign key also restricts the delete; this gives a clean answer.
      if ((projectRows?.value ?? 0) > 0) return { outcome: "has_projects" };
      await tx.delete(teams).where(eq(teams.id, teamId));
      return { outcome: "deleted" };
    });
  }

  async createInvite(invite: NewTeamInvite): Promise<TeamInviteRecord> {
    const [row] = await this.db
      .insert(teamInvites)
      .values({
        id: invite.id,
        teamId: invite.teamId,
        tokenHash: invite.tokenHash,
        role: invite.role,
        invitedEmail: invite.invitedEmail,
        createdByUserId: invite.createdByUserId,
        expiresAt: invite.expiresAt,
        createdAt: invite.now,
      })
      .returning({
        id: teamInvites.id,
        tokenHash: teamInvites.tokenHash,
        role: teamInvites.role,
        invitedEmail: teamInvites.invitedEmail,
        createdByUserId: teamInvites.createdByUserId,
        createdAt: teamInvites.createdAt,
        expiresAt: teamInvites.expiresAt,
      });
    const [creator] = await this.db
      .select({ name: schema.user.name })
      .from(schema.user)
      .where(eq(schema.user.id, invite.createdByUserId))
      .limit(1);
    return { ...row, createdByName: creator?.name ?? null };
  }

  async countEmailedInvitesSince(teamId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ count: count() })
      .from(teamInvites)
      .where(
        and(
          eq(teamInvites.teamId, teamId),
          isNotNull(teamInvites.invitedEmail),
          gt(teamInvites.createdAt, since),
        ),
      );
    return row?.count ?? 0;
  }

  async countEmailedInvitesBySenderSince(userId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ count: count() })
      .from(teamInvites)
      .where(
        and(
          eq(teamInvites.createdByUserId, userId),
          isNotNull(teamInvites.invitedEmail),
          gt(teamInvites.createdAt, since),
        ),
      );
    return row?.count ?? 0;
  }

  async countEmailedInvitesToSince(userId: string, email: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ count: count() })
      .from(teamInvites)
      .where(
        and(
          eq(teamInvites.createdByUserId, userId),
          eq(teamInvites.invitedEmail, email),
          gt(teamInvites.createdAt, since),
        ),
      );
    return row?.count ?? 0;
  }

  async countOwnedTeams(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: count() })
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, userId), eq(teamMembers.role, "owner")));
    return row?.count ?? 0;
  }

  async revokeInvite(teamId: string, inviteId: string, now: Date): Promise<boolean> {
    const revoked = await this.db
      .update(teamInvites)
      .set({ revokedAt: now })
      .where(and(eq(teamInvites.id, inviteId), eq(teamInvites.teamId, teamId), pendingInvite(now)))
      .returning({ id: teamInvites.id });
    return revoked.length > 0;
  }

  async findInvite(tokenHash: string): Promise<InviteLookup | null> {
    const [row] = await this.db
      .select({
        teamId: teamInvites.teamId,
        teamName: teams.name,
        role: teamInvites.role,
        expiresAt: teamInvites.expiresAt,
        usedAt: teamInvites.usedAt,
        revokedAt: teamInvites.revokedAt,
        invitedEmail: teamInvites.invitedEmail,
      })
      .from(teamInvites)
      .innerJoin(teams, eq(teams.id, teamInvites.teamId))
      .where(eq(teamInvites.tokenHash, tokenHash))
      .limit(1);
    return row ?? null;
  }

  findVerifiedEmail(userId: string): Promise<string | null> {
    return verifiedEmailOf(this.db, userId);
  }

  acceptInvite(tokenHash: string, userId: string, now: Date): Promise<InviteAcceptance> {
    return this.db.transaction(async (tx) => {
      // The row lock makes the link single-use under concurrent accepts.
      const [invite] = await tx
        .select({
          id: teamInvites.id,
          teamId: teamInvites.teamId,
          role: teamInvites.role,
          expiresAt: teamInvites.expiresAt,
          usedAt: teamInvites.usedAt,
          revokedAt: teamInvites.revokedAt,
          invitedEmail: teamInvites.invitedEmail,
        })
        .from(teamInvites)
        .where(eq(teamInvites.tokenHash, tokenHash))
        .for("update")
        .limit(1);
      if (!invite) return { outcome: "invite_not_found" };
      if (invite.revokedAt !== null) return { outcome: "invite_revoked" };
      if (invite.usedAt !== null) return { outcome: "invite_used" };
      if (invite.expiresAt <= now) return { outcome: "invite_expired" };
      // SEC-017: an invite sent to an address works only for that address.
      if (invite.invitedEmail !== null && (await verifiedEmailOf(tx, userId)) !== invite.invitedEmail) {
        return { outcome: "invite_email_mismatch" };
      }
      // A concurrent accept of another link of this team may add the user
      // first; the conflict then reads as "already a member", not an error.
      const added = await tx
        .insert(teamMembers)
        .values({ teamId: invite.teamId, userId, role: invite.role, createdAt: now, updatedAt: now })
        .onConflictDoNothing()
        .returning({ userId: teamMembers.userId });
      if (added.length === 0) return { outcome: "already_member" };
      await tx
        .update(teamInvites)
        .set({ usedAt: now, usedByUserId: userId })
        .where(eq(teamInvites.id, invite.id));
      return { outcome: "accepted", teamId: invite.teamId, role: invite.role };
    });
  }

  setRole(teamId: string, userId: string, role: TeamRole, now: Date): Promise<MembershipChange> {
    return this.db.transaction(async (tx) => {
      const guard = await guardLastOwner(tx, teamId, userId, role !== "owner");
      if (guard) return guard;
      await tx
        .update(teamMembers)
        .set({ role, updatedAt: now })
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
      return { outcome: "changed" };
    });
  }

  removeMember(teamId: string, userId: string): Promise<MembershipChange> {
    return this.db.transaction(async (tx) => {
      const guard = await guardLastOwner(tx, teamId, userId, true);
      if (guard) return guard;
      await tx
        .delete(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
      return { outcome: "changed" };
    });
  }

  async moveProject(projectId: string, teamId: string, now: Date): Promise<ProjectMove> {
    const moved = await this.db
      .update(projects)
      .set({ teamId, updatedAt: now })
      .where(and(eq(projects.id, projectId), isNull(projects.teamId)))
      .returning({ id: projects.id });
    if (moved.length > 0) return { outcome: "moved" };
    const [existing] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return existing ? { outcome: "already_in_team" } : { outcome: "not_found" };
  }
}

async function findRole(db: DoxaDb | Tx, teamId: string, userId: string): Promise<TeamRole | null> {
  const [row] = await db
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1);
  return row?.role ?? null;
}

/** Serializes membership writes of one team, so the owner count stays true. */
async function lockTeam(tx: Tx, teamId: string): Promise<boolean> {
  const [row] = await tx.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).for("update").limit(1);
  return row !== undefined;
}

/**
 * Locks the team, then refuses a change that takes the owner role away from
 * the last owner. Null when the change may go on.
 */
async function guardLastOwner(
  tx: Tx,
  teamId: string,
  userId: string,
  removesOwnerRole: boolean,
): Promise<MembershipChange | null> {
  if (!(await lockTeam(tx, teamId))) return { outcome: "not_member" };
  const current = await findRole(tx, teamId, userId);
  if (current === null) return { outcome: "not_member" };
  if (current !== "owner" || !removesOwnerRole) return null;
  const [owners] = await tx
    .select({ value: count() })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "owner")));
  return (owners?.value ?? 0) <= 1 ? { outcome: "last_owner" } : null;
}

function pendingInvite(now: Date) {
  return and(isNull(teamInvites.usedAt), isNull(teamInvites.revokedAt), gt(teamInvites.expiresAt, now));
}

/** The user's email in lowercase, or null when the provider did not verify it. */
async function verifiedEmailOf(db: DoxaDb | Tx, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ email: schema.user.email, emailVerified: schema.user.emailVerified })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  return row?.emailVerified ? row.email.trim().toLowerCase() : null;
}
