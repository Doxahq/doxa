import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";

/**
 * The privacy switches of a person. Doxa owns this table, not Better Auth.
 * A missing row means every switch has its default: product analytics is on.
 */
export const userPrivacySettings = pgTable("user_privacy_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  productAnalytics: boolean("product_analytics").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
