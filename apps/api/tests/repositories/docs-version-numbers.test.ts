import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import { nextDocsVersionNumber } from "../../src/repositories/docs-version-numbers";

function reader(rows: Array<{ versionNumber: number }>) {
  const captured: { where?: SQL } = {};
  const chain = {
    from: () => chain,
    where: (condition: SQL) => {
      captured.where = condition;
      return chain;
    },
    orderBy: () => chain,
    limit: async () => rows,
  };
  return { db: { select: () => chain }, captured };
}

describe("docs version numbers", () => {
  test.each(["production", "preview"] as const)(
    "counts %s versions in their own sequence",
    async (channel) => {
      const { db, captured } = reader([{ versionNumber: 7 }]);

      await expect(
        nextDocsVersionNumber(db as never, { siteId: "site-1", channel }),
      ).resolves.toBe(8);

      const query = new PgDialect().sqlToQuery(captured.where as SQL);
      expect(query.sql).toContain('"channel" = $2');
      expect(query.params).toEqual(["site-1", channel]);
    },
  );

  test("starts a channel at 1", async () => {
    const { db } = reader([]);

    await expect(
      nextDocsVersionNumber(db as never, {
        siteId: "site-1",
        channel: "preview",
      }),
    ).resolves.toBe(1);
  });
});
