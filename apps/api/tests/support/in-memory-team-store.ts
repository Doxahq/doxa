import type { TeamProject, TeamRole } from "@doxahq/contracts/teams";
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
} from "../../src/services/teams/team-store";
import type { InMemoryProjectAccess } from "./in-memory-project-access";

interface StoredInvite {
  id: string;
  teamId: string;
  tokenHash: string;
  role: TeamRole;
  invitedEmail: string | null;
  createdByUserId: string;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  usedByUserId: string | null;
  revokedAt: Date | null;
}

/**
 * Same rules as the Drizzle store. Memberships live in the shared
 * `InMemoryProjectAccess`, so the access policy sees every change at once.
 */
export class InMemoryTeamStore implements TeamStore {
  readonly teams = new Map<string, TeamRecord>();
  readonly invites: StoredInvite[] = [];
  private nextId = 1;

  constructor(
    readonly access: InMemoryProjectAccess,
    private readonly users: Record<string, string> = {},
  ) {}

  async listForUser(userId: string): Promise<TeamSummaryRecord[]> {
    return [...this.teams.values()].flatMap((team) => {
      const role = this.roleOf(team.id, userId);
      if (role === null) return [];
      return [{ ...team, role, memberCount: this.membersOf(team.id).size, projectCount: this.projectIds(team.id).length }];
    });
  }

  async findTeam(teamId: string): Promise<TeamRecord | null> {
    return this.teams.get(teamId) ?? null;
  }

  async findRole(teamId: string, userId: string): Promise<TeamRole | null> {
    return this.roleOf(teamId, userId);
  }

  async listMembers(teamId: string): Promise<TeamMemberRecord[]> {
    return [...this.membersOf(teamId)].map(([userId, role]) => ({
      userId,
      name: this.users[userId] ?? userId,
      email: `${userId}@example.com`,
      image: null,
      role,
      joinedAt: new Date(0),
    }));
  }

  async listPendingInvites(teamId: string, now: Date): Promise<TeamInviteRecord[]> {
    return this.invites
      .filter((invite) => invite.teamId === teamId && isPending(invite, now))
      .map((invite) => this.toRecord(invite));
  }

  async listProjects(teamId: string): Promise<TeamProject[]> {
    return this.projectIds(teamId).map((id) => ({ id, name: `Project ${id.slice(0, 4)}`, slug: `project-${id.slice(0, 4)}` }));
  }

  async create(input: { name: string; ownerUserId: string; now: Date }): Promise<TeamRecord> {
    const team = { id: this.uuid(), name: input.name, createdAt: input.now };
    this.teams.set(team.id, team);
    this.access.join(team.id, input.ownerUserId, "owner");
    return team;
  }

  async rename(teamId: string, name: string): Promise<void> {
    const team = this.teams.get(teamId);
    if (team) this.teams.set(teamId, { ...team, name });
  }

  async delete(teamId: string): Promise<TeamDeletion> {
    if (!this.teams.has(teamId)) return { outcome: "not_found" };
    if (this.projectIds(teamId).length > 0) return { outcome: "has_projects" };
    this.teams.delete(teamId);
    this.access.members.delete(teamId);
    return { outcome: "deleted" };
  }

  async createInvite(invite: NewTeamInvite): Promise<TeamInviteRecord> {
    const stored: StoredInvite = {
      id: invite.id,
      teamId: invite.teamId,
      tokenHash: invite.tokenHash,
      role: invite.role,
      invitedEmail: invite.invitedEmail,
      createdByUserId: invite.createdByUserId,
      createdAt: invite.now,
      expiresAt: invite.expiresAt,
      usedAt: null,
      usedByUserId: null,
      revokedAt: null,
    };
    this.invites.push(stored);
    return this.toRecord(stored);
  }

  async countEmailedInvitesSince(teamId: string, since: Date): Promise<number> {
    return this.invites.filter(
      (invite) => invite.teamId === teamId && invite.invitedEmail !== null && invite.createdAt > since,
    ).length;
  }

  async revokeInvite(teamId: string, inviteId: string, now: Date): Promise<boolean> {
    const invite = this.invites.find((entry) => entry.id === inviteId && entry.teamId === teamId);
    if (!invite || !isPending(invite, now)) return false;
    invite.revokedAt = now;
    return true;
  }

  async findInvite(tokenHash: string): Promise<InviteLookup | null> {
    const invite = this.invites.find((entry) => entry.tokenHash === tokenHash);
    const team = invite ? this.teams.get(invite.teamId) : undefined;
    if (!invite || !team) return null;
    return {
      teamId: invite.teamId,
      teamName: team.name,
      role: invite.role,
      expiresAt: invite.expiresAt,
      usedAt: invite.usedAt,
      revokedAt: invite.revokedAt,
    };
  }

  async acceptInvite(tokenHash: string, userId: string, now: Date): Promise<InviteAcceptance> {
    const invite = this.invites.find((entry) => entry.tokenHash === tokenHash);
    if (!invite) return { outcome: "invite_not_found" };
    if (invite.revokedAt !== null) return { outcome: "invite_revoked" };
    if (invite.usedAt !== null) return { outcome: "invite_used" };
    if (invite.expiresAt <= now) return { outcome: "invite_expired" };
    if (this.roleOf(invite.teamId, userId) !== null) return { outcome: "already_member" };
    this.access.join(invite.teamId, userId, invite.role);
    invite.usedAt = now;
    invite.usedByUserId = userId;
    return { outcome: "accepted", teamId: invite.teamId, role: invite.role };
  }

  async setRole(teamId: string, userId: string, role: TeamRole): Promise<MembershipChange> {
    const guard = this.guardLastOwner(teamId, userId, role !== "owner");
    if (guard) return guard;
    this.access.join(teamId, userId, role);
    return { outcome: "changed" };
  }

  async removeMember(teamId: string, userId: string): Promise<MembershipChange> {
    const guard = this.guardLastOwner(teamId, userId, true);
    if (guard) return guard;
    this.access.leave(teamId, userId);
    return { outcome: "changed" };
  }

  async moveProject(projectId: string, teamId: string): Promise<ProjectMove> {
    const project = this.access.projects.get(projectId);
    if (!project) return { outcome: "not_found" };
    if ((project.teamId ?? null) !== null) return { outcome: "already_in_team" };
    this.access.moveToTeam(projectId, teamId);
    return { outcome: "moved" };
  }

  private guardLastOwner(teamId: string, userId: string, removesOwnerRole: boolean): MembershipChange | null {
    const current = this.roleOf(teamId, userId);
    if (current === null) return { outcome: "not_member" };
    if (current !== "owner" || !removesOwnerRole) return null;
    const owners = [...this.membersOf(teamId).values()].filter((role) => role === "owner").length;
    return owners <= 1 ? { outcome: "last_owner" } : null;
  }

  private toRecord(invite: StoredInvite): TeamInviteRecord {
    return {
      id: invite.id,
      tokenHash: invite.tokenHash,
      role: invite.role,
      invitedEmail: invite.invitedEmail,
      createdByUserId: invite.createdByUserId,
      createdByName: this.users[invite.createdByUserId] ?? null,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
    };
  }

  private roleOf(teamId: string, userId: string): TeamRole | null {
    return this.access.members.get(teamId)?.get(userId) ?? null;
  }

  private membersOf(teamId: string): ReadonlyMap<string, TeamRole> {
    return this.access.members.get(teamId) ?? new Map();
  }

  private projectIds(teamId: string): string[] {
    return [...this.access.projects].filter(([, project]) => project.teamId === teamId).map(([id]) => id);
  }

  private uuid(): string {
    const suffix = String(this.nextId++).padStart(12, "0");
    return `00000000-0000-4000-8000-${suffix}`;
  }
}

function isPending(invite: StoredInvite, now: Date): boolean {
  return invite.usedAt === null && invite.revokedAt === null && invite.expiresAt > now;
}
