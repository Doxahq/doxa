import { and, desc, eq } from "drizzle-orm";
import { schema, type DoxaDb } from "@doxahq/db";

type VersionNumberReader = Pick<DoxaDb, "select">;
type DocsVersionChannel = (typeof schema.docsVersions.$inferInsert)["channel"];

/**
 * Returns the next version number in one channel of a site.
 *
 * Production and preview versions count separately, so a preview never takes
 * a published number. The caller must hold the lock on the site row, because
 * two writers that read the same maximum would insert the same number.
 */
export async function nextDocsVersionNumber(
  db: VersionNumberReader,
  input: { siteId: string; channel: NonNullable<DocsVersionChannel> },
): Promise<number> {
  const [latest] = await db
    .select({ versionNumber: schema.docsVersions.versionNumber })
    .from(schema.docsVersions)
    .where(
      and(
        eq(schema.docsVersions.siteId, input.siteId),
        eq(schema.docsVersions.channel, input.channel),
      ),
    )
    .orderBy(desc(schema.docsVersions.versionNumber))
    .limit(1);

  return (latest?.versionNumber ?? 0) + 1;
}
