import { schema } from "@doxahq/db";
import { EMAIL_NOTIFICATION_CATEGORIES } from "@doxahq/email/catalog";
import { EMAIL_DELIVERY_STATUSES } from "@doxahq/contracts/email-deliveries";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

describe("email schema (email spec §9.1)", () => {
  it("keeps one delivery for each dedupe key", () => {
    const config = getTableConfig(schema.emailDeliveries);
    const unique = config.indexes.filter((index) => index.config.unique).map((index) => index.config.name);
    expect(unique).toEqual(["email_deliveries_dedupe_key_idx"]);
  });

  it("matches the shared status and category lists", () => {
    expect(schema.emailDeliveryStatus.enumValues).toEqual([...EMAIL_DELIVERY_STATUSES]);
    expect(schema.emailNotificationCategory.enumValues).toEqual([...EMAIL_NOTIFICATION_CATEGORIES]);
  });

  it("stores no rendered email: the row holds the kind and its props", () => {
    const columns = getTableConfig(schema.emailDeliveries).columns.map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["kind", "props", "headers", "dedupe_key", "claim_token"]));
    expect(columns).not.toContain("html");
  });

  it("keeps one preference for each user and category", () => {
    const config = getTableConfig(schema.emailPreferences);
    expect(config.primaryKeys.map((key) => key.columns.map((column) => column.name))).toEqual([["user_id", "category"]]);
  });
});
