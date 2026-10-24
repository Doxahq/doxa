import { and, asc, eq, inArray, isNotNull, isNull, lte, gt, or, sql, type SQL } from "drizzle-orm";
import { createDb, schema, type DbEnv, type DoxaDb } from "@doxahq/db";

const { docsDomains, projects } = schema;

/** A custom domain that the cron checks now, with the owner that the domain service needs. */
export interface DueDomainCheck {
  readonly domainId: string;
  readonly projectId: string;
  readonly ownerUserId: string;
}

/** Cut-off times: a domain last checked at or before a cut-off is due. */
export interface DueDomainWindows {
  readonly now: Date;
  /** A pending domain created after this time is new. */
  readonly newPendingCreatedAfter: Date;
  readonly newPendingCheckedBefore: Date;
  readonly oldPendingCheckedBefore: Date;
  readonly verifiedCheckedBefore: Date;
  readonly limit: number;
}

export interface DocsDomainCheckStore {
  /**
   * Claims the due custom domains, oldest check first, and sets their
   * `last_checked_at` to `now`. Rows that another run holds are skipped.
   */
  claimDue(windows: DueDomainWindows): Promise<DueDomainCheck[]>;
}

export class DocsDomainChecksRepository implements DocsDomainCheckStore {
  constructor(private readonly db: DoxaDb) {}

  static fromEnv(env: DbEnv): DocsDomainChecksRepository {
    return new DocsDomainChecksRepository(createDb(env));
  }

  claimDue(windows: DueDomainWindows): Promise<DueDomainCheck[]> {
    return this.db.transaction(async (tx) => {
      const due = await tx
        .select({ domainId: docsDomains.id, projectId: docsDomains.projectId, ownerUserId: projects.userId })
        .from(docsDomains)
        .innerJoin(projects, eq(projects.id, docsDomains.projectId))
        .where(dueDomainCondition(windows))
        .orderBy(sql`${docsDomains.lastCheckedAt} asc nulls first`, asc(docsDomains.id))
        .limit(windows.limit)
        .for("update", { of: docsDomains, skipLocked: true });
      if (due.length === 0) return [];
      await tx
        .update(docsDomains)
        .set({ lastCheckedAt: windows.now })
        .where(inArray(docsDomains.id, due.map((row) => row.domainId)));
      return due;
    });
  }
}

/** Exported for the SQL shape test. */
export function dueDomainCondition(windows: DueDomainWindows): SQL | undefined {
  const neverChecked = isNull(docsDomains.lastCheckedAt);
  return and(
    eq(docsDomains.kind, "custom_domain"),
    eq(docsDomains.status, "active"),
    isNotNull(docsDomains.providerHostnameId),
    or(
      and(
        eq(docsDomains.verificationStatus, "pending"),
        or(
          neverChecked,
          and(
            gt(docsDomains.createdAt, windows.newPendingCreatedAfter),
            lte(docsDomains.lastCheckedAt, windows.newPendingCheckedBefore),
          ),
          lte(docsDomains.lastCheckedAt, windows.oldPendingCheckedBefore),
        ),
      ),
      and(
        eq(docsDomains.verificationStatus, "verified"),
        or(neverChecked, lte(docsDomains.lastCheckedAt, windows.verifiedCheckedBefore)),
      ),
    ),
  );
}
