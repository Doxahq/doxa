import type { OwnerKind, ProjectOwnershipPort } from "@doxahq/billing";
import { createDb, schema, type DbEnv, type DoxaDb } from "@doxahq/db";
import { and, asc, count, desc, eq, isNull, ne } from "drizzle-orm";

const { projects, docsDomains, user, generationJobs, teamMembers } = schema;

/** Counts that billing limits need across all projects of one billing account. */
export interface BillingAccountUsage {
  /**
   * Custom domains on the account's projects other than `exceptProjectId`
   * (decision D9: the domain limit is for each account). A team account
   * holds the team's projects; a personal account holds the user's
   * projects that have no team (billing spec 8.1).
   */
  countCustomDomains(input: { ownerKind: OwnerKind; ownerId: string; exceptProjectId: string }): Promise<number>;
  /** The account's projects, for the `account.projects` limit. Same ownership rule as above. */
  countProjects(input: { ownerKind: OwnerKind; ownerId: string }): Promise<number>;
}

/** The recent runs of a project, for the credit estimate (billing spec 10.5). */
export interface BillingRunHistory {
  /** Job IDs of the project, newest first. */
  recentJobIds(projectId: string, limit: number): Promise<string[]>;
}

export interface BillingContact {
  /** The owner's Doxa user ID: product analytics counts billing facts for this person. */
  userId: string;
  email: string | null;
  name: string | null;
}

/**
 * The billing contact sent to the provider customer (name and email, never
 * stored in logs). It is the account owner's, whoever opens Checkout: Checkout
 * shows the customer's email locked, so every member sees the same one.
 */
export interface BillingContactDirectory {
  /**
   * A personal account: the user's email and name. A team: the email of its
   * first owner (the oldest `owner` membership), and no name. Null when the
   * owner is gone.
   */
  billingContactOf(owner: { ownerKind: OwnerKind; ownerId: string | null }): Promise<BillingContact | null>;
}

/**
 * The `ProjectOwnershipPort` of `@doxahq/billing` (project -> team or owner)
 * and the cross-project counts of an account, from the `projects` table.
 */
export class BillingOwnershipRepository implements ProjectOwnershipPort, BillingAccountUsage, BillingContactDirectory, BillingRunHistory {
  private readonly db: DoxaDb;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  async getProjectOwnership(projectId: string): Promise<{ userId: string; teamId: string | null } | null> {
    const [row] = await this.db
      .select({ userId: projects.userId, teamId: projects.teamId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return row ? { userId: row.userId, teamId: row.teamId ?? null } : null;
  }

  async countCustomDomains(input: { ownerKind: OwnerKind; ownerId: string; exceptProjectId: string }): Promise<number> {
    const owner = accountProjectsFilter(input);
    const [row] = await this.db
      .select({ value: count() })
      .from(docsDomains)
      .innerJoin(projects, eq(projects.id, docsDomains.projectId))
      .where(and(owner, eq(docsDomains.kind, "custom_domain"), ne(docsDomains.projectId, input.exceptProjectId)));
    return row?.value ?? 0;
  }

  async countProjects(input: { ownerKind: OwnerKind; ownerId: string }): Promise<number> {
    const [row] = await this.db.select({ value: count() }).from(projects).where(accountProjectsFilter(input));
    return row?.value ?? 0;
  }

  async billingContactOf(owner: { ownerKind: OwnerKind; ownerId: string | null }): Promise<BillingContact | null> {
    if (!owner.ownerId) return null;
    if (owner.ownerKind === "user") {
      const [row] = await this.db
        .select({ userId: user.id, email: user.email, name: user.name })
        .from(user)
        .where(eq(user.id, owner.ownerId))
        .limit(1);
      return row ? { userId: row.userId, email: row.email ?? null, name: row.name ?? null } : null;
    }
    const [row] = await this.db
      .select({ userId: user.id, email: user.email })
      .from(teamMembers)
      .innerJoin(user, eq(user.id, teamMembers.userId))
      .where(and(eq(teamMembers.teamId, owner.ownerId), eq(teamMembers.role, "owner")))
      .orderBy(asc(teamMembers.createdAt), asc(teamMembers.userId))
      .limit(1);
    return row ? { userId: row.userId, email: row.email ?? null, name: null } : null;
  }

  async recentJobIds(projectId: string, limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ id: generationJobs.id })
      .from(generationJobs)
      .where(eq(generationJobs.projectId, projectId))
      .orderBy(desc(generationJobs.createdAt))
      .limit(limit);
    return rows.map((row) => row.id);
  }
}

/** The projects of one billing account (billing spec 8.1). */
function accountProjectsFilter(input: { ownerKind: OwnerKind; ownerId: string }) {
  return input.ownerKind === "team"
    ? eq(projects.teamId, input.ownerId)
    : and(eq(projects.userId, input.ownerId), isNull(projects.teamId));
}
