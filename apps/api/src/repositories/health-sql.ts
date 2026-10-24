import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * Age in seconds of the oldest row that still waits for work.
 *
 * Postgres accepts FILTER only directly after an aggregate call, so the
 * clause belongs to `min(...)` and not to the `extract(...)` around it. One
 * helper keeps every health query on the correct form.
 */
export function oldestOpenRowAgeSeconds(input: {
  createdAt: PgColumn;
  status: PgColumn;
  openStatuses: readonly string[];
}): SQL<number> {
  return sql<number>`coalesce(extract(epoch from now() - min(${input.createdAt}) filter (where ${input.status} in ${sql`(${sql.join(
    input.openStatuses.map((status) => sql`${status}`),
    sql`, `,
  )})`})), 0)`;
}
