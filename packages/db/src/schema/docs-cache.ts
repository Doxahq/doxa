import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// No site/domain FK: a removal must not delete its outstanding invalidation.
export const docsCacheInvalidations = pgTable(
  "docs_cache_invalidations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id").notNull(),
    hostname: text("hostname"),
    attempts: integer("attempts").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    claimToken: uuid("claim_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("docs_cache_invalidations_pending_idx")
      .on(table.nextAttemptAt)
      .where(sql`${table.completedAt} is null`),
  ],
);
