import type {
  TeamInviteFailure,
  TeamProject,
  TeamRole,
} from "@doxahq/contracts/teams";

export interface TeamRecord {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
}

export interface TeamSummaryRecord extends TeamRecord {
  /** The listing user's role. */
  readonly role: TeamRole;
  readonly memberCount: number;
  readonly projectCount: number;
}

export interface TeamMemberRecord {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly image: string | null;
  readonly role: TeamRole;
  readonly joinedAt: Date;
}

export interface TeamInviteRecord {
  readonly id: string;
  /** Lets the service tell a derived token (link can be shown) from an older random one. */
  readonly tokenHash: string;
  readonly role: TeamRole;
  /** Set when the link was sent by email. */
  readonly invitedEmail: string | null;
  readonly createdByUserId: string | null;
  readonly createdByName: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** An invite found by its token hash, in any state. */
export interface InviteLookup {
  readonly teamId: string;
  readonly teamName: string;
  readonly role: TeamRole;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
  readonly revokedAt: Date | null;
  /** Lowercase. Null for an invite link without an address. */
  readonly invitedEmail: string | null;
}

export interface NewTeamInvite {
  /** Chosen before the insert: the token is derived from it. */
  readonly id: string;
  readonly teamId: string;
  readonly tokenHash: string;
  readonly role: TeamRole;
  /** Lowercase, or null for a link that a manager copies. */
  readonly invitedEmail: string | null;
  readonly createdByUserId: string;
  readonly expiresAt: Date;
  readonly now: Date;
}

export type MembershipChange =
  | { readonly outcome: "changed" }
  | { readonly outcome: "not_member" }
  /** The change would leave the team with no owner. */
  | { readonly outcome: "last_owner" };

export type InviteAcceptance =
  | { readonly outcome: "accepted"; readonly teamId: string; readonly role: TeamRole }
  | { readonly outcome: TeamInviteFailure };

export type TeamDeletion =
  | { readonly outcome: "deleted" }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "has_projects" };

export type ProjectMove =
  | { readonly outcome: "moved" }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "already_in_team" };

/**
 * Persistence of teams, members and invites. Every write that guards an
 * invariant (one owner stays, an invite works once) is atomic in the store,
 * so two requests at once cannot break it.
 */
export interface TeamStore {
  listForUser(userId: string): Promise<TeamSummaryRecord[]>;
  findTeam(teamId: string): Promise<TeamRecord | null>;
  /** Null when the user is not a member. */
  findRole(teamId: string, userId: string): Promise<TeamRole | null>;
  listMembers(teamId: string): Promise<TeamMemberRecord[]>;
  /** Not used, not revoked, not expired at `now`. */
  listPendingInvites(teamId: string, now: Date): Promise<TeamInviteRecord[]>;
  listProjects(teamId: string): Promise<TeamProject[]>;
  /** Creates the team with its creator as the first owner. */
  create(input: { name: string; ownerUserId: string; now: Date }): Promise<TeamRecord>;
  rename(teamId: string, name: string, now: Date): Promise<void>;
  /** Refuses while the team has projects. */
  delete(teamId: string): Promise<TeamDeletion>;
  createInvite(invite: NewTeamInvite): Promise<TeamInviteRecord>;
  /** Invites of the team sent by email after `since`, for the hourly limit. */
  countEmailedInvitesSince(teamId: string, since: Date): Promise<number>;
  /** Invites sent by email by this user in any team after `since`. */
  countEmailedInvitesBySenderSince(userId: string, since: Date): Promise<number>;
  /** Invites this user sent by email to this address, in any team, after `since`. */
  countEmailedInvitesToSince(userId: string, email: string, since: Date): Promise<number>;
  /** Teams in which the user is an owner. */
  countOwnedTeams(userId: string): Promise<number>;
  /** False when no pending invite of this team has the ID. */
  revokeInvite(teamId: string, inviteId: string, now: Date): Promise<boolean>;
  findInvite(tokenHash: string): Promise<InviteLookup | null>;
  /** The user's email in lowercase, or null when it is not verified. */
  findVerifiedEmail(userId: string): Promise<string | null>;
  /** Marks the invite used and adds the member, or fails without a change. */
  acceptInvite(tokenHash: string, userId: string, now: Date): Promise<InviteAcceptance>;
  setRole(teamId: string, userId: string, role: TeamRole, now: Date): Promise<MembershipChange>;
  removeMember(teamId: string, userId: string): Promise<MembershipChange>;
  /** Projects of the team whose owner (`projects.user_id`) is this user. */
  listProjectsOwnedBy(teamId: string, userId: string): Promise<TeamProject[]>;
  /** Moves a personal project into a team. */
  moveProject(projectId: string, teamId: string, now: Date): Promise<ProjectMove>;
}
