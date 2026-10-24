import { schema } from "@doxahq/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";

import { oldestOpenRowAgeSeconds } from "../../src/repositories/health-sql";

/**
 * Postgres accepts FILTER only directly after an aggregate call.
 *
 * `extract(epoch from now() - min(x)) filter (where ...)` is a syntax error
 * that reaches production at run time only. This test renders the real
 * expression that both health queries use.
 */
describe("health query SQL", () => {
  test.each([
    {
      label: "pre-render tasks",
      createdAt: schema.docsPrerenderTasks.createdAt,
      status: schema.docsPrerenderTasks.status,
    },
    {
      label: "storage collection entries",
      createdAt: schema.storageGcEntries.createdAt,
      status: schema.storageGcEntries.status,
    },
  ])("attaches FILTER to the aggregate for $label", ({ createdAt, status }) => {
    const query = new PgDialect().sqlToQuery(
      oldestOpenRowAgeSeconds({
        createdAt,
        status,
        openStatuses: ["pending", "running", "failed"],
      }),
    );

    expect(query.sql).toMatch(/min\("[\w.\"]*created_at"\) filter \(where /);
    // A FILTER clause after a closing pair belongs to no aggregate call.
    expect(query.sql).not.toMatch(/\)\)\s*filter\s*\(/i);
    expect(query.params).toEqual(["pending", "running", "failed"]);
  });
});
