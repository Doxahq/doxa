import { z } from "zod";

/** v2 spec §5: a member's role in a team, from most to least access. */
export const TEAM_ROLES = ["owner", "admin", "editor", "viewer"] as const;

export const teamRoleSchema = z.enum(TEAM_ROLES);

export type TeamRole = z.infer<typeof teamRoleSchema>;

/** Days an invite link works. */
export const TEAM_INVITE_TTL_DAYS = 7;

/** Invites sent by email, for each team in one hour. Invite links without an email have no limit. */
export const TEAM_INVITE_EMAILS_PER_HOUR = 20;

/**
 * Invites one person sends by email in one hour, over all their teams
 * (SEC-015): new teams must not multiply the team limit.
 */
export const TEAM_INVITE_EMAILS_PER_SENDER_PER_HOUR = 40;

/**
 * Invite emails one sender sends to one address in one day, over all their
 * teams. Counted per sender, so a stranger cannot use up an address's budget
 * and block that person's real team.
 */
export const TEAM_INVITE_EMAILS_PER_RECIPIENT_PER_DAY = 3;

/** Teams one person can own. */
export const MAX_OWNED_TEAMS = 10;

export const MAX_TEAM_NAME_LENGTH = 80;

const teamNameSchema = z.string().trim().min(1).max(MAX_TEAM_NAME_LENGTH);

/**
 * What a principal may do on a project. The API checks these through its
 * `ProjectAccessPolicy`; the dashboard reads them to hide what a role cannot do.
 */
export const CAPABILITIES = [
  "project.read",
  "project.create",
  "project.delete",
  "docs.read",
  "docs.write",
  "site.write",
  "docs.publish",
  "docs.restore",
  "domains.read",
  "domains.write",
  "generation.read",
  "generation.run",
  "approvals.decide",
  /** Changes the project approval settings. Never granted to an agent. */
  "approvals.configure",
  /** Changes the Doxabot instructions of a project. Never granted to an agent. */
  "instructions.configure",
  /** Renames the team, invites, changes roles, removes members. */
  "team.manage",
  "team.delete",
  /**
   * Billing spec 8.2: read the plan, credits and invoices of the team's
   * billing account. Owner and admin only. Never granted to an agent.
   */
  "billing.read",
  /** Checkout, Customer Portal, pay-as-you-go settings and caps. Owner and admin only. Never granted to an agent. */
  "billing.manage",
] as const;

export const capabilitySchema = z.enum(CAPABILITIES);

export type Capability = z.infer<typeof capabilitySchema>;

const VIEWER_CAPABILITIES = [
  "project.read",
  "docs.read",
  "domains.read",
  "generation.read",
] as const satisfies readonly Capability[];

const EDITOR_CAPABILITIES = [
  ...VIEWER_CAPABILITIES,
  "docs.write",
  "site.write",
  "docs.publish",
  "docs.restore",
  "approvals.decide",
] as const satisfies readonly Capability[];

const OWNER_ONLY: ReadonlySet<Capability> = new Set([
  "project.delete",
  "team.delete",
]);

/**
 * v2 spec §5, the role table. `domains.read` and `generation.read` go with
 * `project.read`, as in the `projects:read` scope. A personal project's
 * owner has the `owner` role.
 */
export const ROLE_CAPABILITIES: Readonly<
  Record<TeamRole, ReadonlySet<Capability>>
> = {
  owner: new Set(CAPABILITIES),
  admin: new Set(CAPABILITIES.filter((capability) => !OWNER_ONLY.has(capability))),
  editor: new Set(EDITOR_CAPABILITIES),
  viewer: new Set(VIEWER_CAPABILITIES),
};

export function roleHasCapability(role: TeamRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].has(capability);
}

/** What a project shows about its team; null for a personal project. */
export const projectTeamSchema = z
  .object({ id: z.uuid(), name: z.string() })
  .strict();

export type ProjectTeam = z.infer<typeof projectTeamSchema>;

/** What the viewer may do in a team, so the dashboard hides what it cannot do. */
export const teamPermissionsSchema = z
  .object({
    /** Rename, invite, change roles, remove members. */
    manage: z.boolean(),
    delete: z.boolean(),
  })
  .strict();

export type TeamPermissions = z.infer<typeof teamPermissionsSchema>;

export const teamSummarySchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    /** The viewer's role. */
    role: teamRoleSchema,
    memberCount: z.number().int().nonnegative(),
    projectCount: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export type TeamSummary = z.infer<typeof teamSummarySchema>;

export const teamListSchema = z
  .object({ teams: z.array(teamSummarySchema) })
  .strict();

export type TeamList = z.infer<typeof teamListSchema>;

export const teamMemberSchema = z
  .object({
    userId: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
    role: teamRoleSchema,
    joinedAt: z.iso.datetime(),
  })
  .strict();

export type TeamMember = z.infer<typeof teamMemberSchema>;

/**
 * A pending invite, shown only to members who can manage the team. The store
 * keeps only the token hash; the API derives the link again from the invite ID.
 */
export const teamInviteSchema = z
  .object({
    id: z.uuid(),
    /** The invite link. Null for an older invite whose token cannot be derived. */
    url: z.url().nullable(),
    /** The address the link was sent to. Null for a link that a manager copies. */
    email: z.string().nullable(),
    role: teamRoleSchema,
    createdBy: z
      .object({ userId: z.string(), name: z.string() })
      .strict()
      .nullable(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export type TeamInvite = z.infer<typeof teamInviteSchema>;

export const teamProjectSchema = z
  .object({ id: z.uuid(), name: z.string(), slug: z.string() })
  .strict();

export type TeamProject = z.infer<typeof teamProjectSchema>;

export const teamDetailSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    role: teamRoleSchema,
    permissions: teamPermissionsSchema,
    members: z.array(teamMemberSchema),
    /** Empty unless the viewer can manage the team. */
    invites: z.array(teamInviteSchema),
    projects: z.array(teamProjectSchema),
    createdAt: z.iso.datetime(),
  })
  .strict();

export type TeamDetail = z.infer<typeof teamDetailSchema>;

export const createTeamInputSchema = z
  .object({ name: teamNameSchema })
  .strict();

export type CreateTeamInput = z.infer<typeof createTeamInputSchema>;

export const renameTeamInputSchema = createTeamInputSchema;

export type RenameTeamInput = z.infer<typeof renameTeamInputSchema>;

export const createTeamInviteInputSchema = z
  .object({
    role: teamRoleSchema,
    /** When set, Doxa also sends the invite link to this address. */
    email: z.email().max(254).optional(),
  })
  .strict();

export type CreateTeamInviteInput = z.infer<typeof createTeamInviteInputSchema>;

/** The new invite; its link is also listed with the team's pending invites. */
export const createdTeamInviteSchema = z
  .object({ invite: teamInviteSchema })
  .strict();

export type CreatedTeamInvite = z.infer<typeof createdTeamInviteSchema>;

export const updateTeamMemberInputSchema = z
  .object({ role: teamRoleSchema })
  .strict();

export type UpdateTeamMemberInput = z.infer<typeof updateTeamMemberInputSchema>;

/** What the accept page shows before the user joins. */
export const teamInvitePreviewSchema = z
  .object({
    teamName: z.string(),
    role: teamRoleSchema,
    expiresAt: z.iso.datetime(),
    /** True when the signed-in user is already a member of the team. */
    alreadyMember: z.boolean(),
  })
  .strict();

export type TeamInvitePreview = z.infer<typeof teamInvitePreviewSchema>;

/** Why an invite link no longer works. Each one is a clean failure, not a 500. */
export const TEAM_INVITE_FAILURES = [
  "invite_not_found",
  "invite_used",
  "invite_expired",
  "invite_revoked",
  "already_member",
  "invite_email_mismatch",
] as const;

export const teamInviteFailureSchema = z.enum(TEAM_INVITE_FAILURES);

export type TeamInviteFailure = z.infer<typeof teamInviteFailureSchema>;

export const acceptedTeamInviteSchema = z
  .object({ teamId: z.uuid(), role: teamRoleSchema })
  .strict();

export type AcceptedTeamInvite = z.infer<typeof acceptedTeamInviteSchema>;

export const moveProjectToTeamInputSchema = z
  .object({ teamId: z.uuid() })
  .strict();

export type MoveProjectToTeamInput = z.infer<
  typeof moveProjectToTeamInputSchema
>;

/** Error codes of the team routes, beside the invite failures. */
export const TEAM_ERROR_CODES = [
  "last_owner",
  "owner_role_required",
  "team_has_projects",
  "project_in_team",
  "invite_email_limit",
  "invite_sender_limit",
  "invite_recipient_limit",
  "team_limit",
  "member_owns_projects",
] as const;

export type TeamErrorCode = (typeof TEAM_ERROR_CODES)[number];
