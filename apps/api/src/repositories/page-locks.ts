import { and, eq, inArray } from "drizzle-orm";
import { createDb, schema, type DoxaDb } from "@doxahq/db";
import type { PageLock } from "@doxahq/contracts/generation-reviews";
import { normalizeHref } from "@doxahq/docs-engine";

type LockTransaction = Parameters<Parameters<DoxaDb["transaction"]>[0]>[0];
type LockDatabase = DoxaDb | LockTransaction;

/**
 * A lock is a row of `docs_page_ownership` in state `owned`; the table keeps
 * its first name. Only a person sets a lock, from the page's agent settings.
 * Rows in state `released` come from the earlier rules and mean unlocked.
 */
const LOCKED = "owned" as const;

/** A page that a publication moved: its route before and after. */
export interface PageMove {
  from: string;
  to: string;
}

export async function listSiteLocks(db: LockDatabase, siteId: string): Promise<PageLock[]> {
  const rows = await db
    .select({ href: schema.docsPageOwnership.href })
    .from(schema.docsPageOwnership)
    .where(and(eq(schema.docsPageOwnership.siteId, siteId), eq(schema.docsPageOwnership.state, LOCKED)));

  return rows.sort((left, right) => left.href.localeCompare(right.href));
}

/** The locks that a publication drops and adds. */
export interface LockChanges {
  dropped: string[];
  added: string[];
}

/**
 * What a publication does to the locks: a moved page takes its lock to its
 * new route, and a removed page loses its lock. Other locks stay.
 */
export function lockChangesAfterPublication(input: {
  locked: ReadonlySet<string>;
  moves: readonly PageMove[];
  removedHrefs: readonly string[];
}): LockChanges {
  const moved = input.moves
    .map((move) => ({ from: normalizeHref(move.from), to: normalizeHref(move.to) }))
    .filter((move) => input.locked.has(move.from));
  return {
    dropped: [
      ...moved.map((move) => move.from),
      ...input.removedHrefs.map(normalizeHref).filter((href) => input.locked.has(href)),
    ],
    added: moved.map((move) => move.to),
  };
}

/** Applies `lockChangesAfterPublication` in the publication's transaction. */
export async function followPublishedPages(
  tx: LockTransaction,
  input: { siteId: string; moves: readonly PageMove[]; removedHrefs: readonly string[] },
): Promise<void> {
  if (input.moves.length === 0 && input.removedHrefs.length === 0) return;
  const locked = new Set((await listSiteLocks(tx, input.siteId)).map((lock) => lock.href));
  const changes = lockChangesAfterPublication({ locked, moves: input.moves, removedHrefs: input.removedHrefs });

  if (changes.dropped.length > 0) {
    await tx
      .delete(schema.docsPageOwnership)
      .where(and(eq(schema.docsPageOwnership.siteId, input.siteId), inArray(schema.docsPageOwnership.href, changes.dropped)));
  }
  for (const href of changes.added) {
    await writeLock(tx, { siteId: input.siteId, href, userId: null });
  }
}

async function writeLock(
  db: LockDatabase,
  input: { siteId: string; href: string; userId: string | null },
): Promise<void> {
  const updatedAt = new Date();
  await db
    .insert(schema.docsPageOwnership)
    .values({ siteId: input.siteId, href: input.href, state: LOCKED, updatedByUserId: input.userId, updatedAt })
    .onConflictDoUpdate({
      target: [schema.docsPageOwnership.siteId, schema.docsPageOwnership.href],
      set: { state: LOCKED, updatedAt, ...(input.userId ? { updatedByUserId: input.userId } : {}) },
    });
}

/** The page locks of the site of a project that `ownerUserId` owns. */
export class PageLocksRepository {
  private readonly db: DoxaDb;

  constructor(env: Parameters<typeof createDb>[0]) {
    this.db = createDb(env);
  }

  async list(input: { projectId: string; ownerUserId: string }): Promise<PageLock[] | null> {
    const siteId = await this.ownedSiteId(input);
    return siteId ? listSiteLocks(this.db, siteId) : null;
  }

  /** Locks or unlocks one page. Returns false for an unknown project. */
  async set(input: {
    projectId: string;
    ownerUserId: string;
    actorUserId: string;
    href: string;
    locked: boolean;
  }): Promise<boolean> {
    const siteId = await this.ownedSiteId(input);
    if (!siteId) return false;

    const href = normalizeHref(input.href);
    if (input.locked) {
      await writeLock(this.db, { siteId, href, userId: input.actorUserId });
    } else {
      await this.db
        .delete(schema.docsPageOwnership)
        .where(and(eq(schema.docsPageOwnership.siteId, siteId), eq(schema.docsPageOwnership.href, href)));
    }
    return true;
  }

  private async ownedSiteId(input: { projectId: string; ownerUserId: string }): Promise<string | null> {
    const [site] = await this.db
      .select({ id: schema.docsSites.id })
      .from(schema.projects)
      .innerJoin(schema.docsSites, eq(schema.docsSites.projectId, schema.projects.id))
      .where(and(eq(schema.projects.id, input.projectId), eq(schema.projects.userId, input.ownerUserId)))
      .limit(1);

    return site?.id ?? null;
  }
}
