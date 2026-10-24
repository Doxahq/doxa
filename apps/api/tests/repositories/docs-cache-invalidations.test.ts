import { schema } from "@doxahq/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, test } from "vitest";
import {
  DocsCacheInvalidationsRepository,
  type ClaimedDocsCacheInvalidation,
} from "../../src/repositories/docs-cache-invalidations";

// Exercise Drizzle's real transaction and SQL builder. Only the pg transport is
// replaced; PostgreSQL lock contention still needs a database integration test.
function database(responses: unknown[][][] = []) {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const client = {
    query: async (query: string | { text: string }, params: unknown[] = []) => {
      const text = typeof query === "string" ? query : query.text;
      queries.push({ text, params });
      return {
        rows: /^(begin|commit|rollback)$/.test(text)
          ? []
          : (responses.shift() ?? []),
      };
    },
  };
  const db = drizzle(client as never, { schema });
  return { repository: new DocsCacheInvalidationsRepository(db), queries };
}

const task: ClaimedDocsCacheInvalidation = {
  id: "b0353b3b-a3e8-4666-bfea-7fc68a810b64",
  siteId: "06ce4a81-0075-430d-84ca-8a0effaaae8e",
  hostname: "docs.example.com",
  attempts: 2,
  claimToken: "33281ac3-516b-405a-a1ec-f9f7bbd7c723",
};

describe("docs cache invalidation SQL", () => {
  test("claims only due, incomplete, unleased or expired tasks under a row lock", async () => {
    const state = database([
      [[task.id]],
      [
        [
          task.id,
          task.siteId,
          task.hostname,
          2,
          "2026-09-16",
          task.claimToken,
          "2026-09-16",
          null,
          null,
          "2026-09-16",
        ],
      ],
    ]);
    const claimed = await state.repository.claim([task.id]);
    expect(state.queries.map(({ text }) => text)).toEqual([
      "begin",
      expect.stringContaining("for update skip locked"),
      expect.stringContaining('update "docs_cache_invalidations"'),
      "commit",
    ]);
    const select = state.queries[1];
    expect(select.text).toContain('"completed_at" is null');
    expect(select.text).toContain('"next_attempt_at" <= now()');
    expect(select.text).toContain('"lease_until" is null');
    expect(select.text).toContain('"lease_until" <= now()');
    expect(select.params).toEqual([task.id, 25]);
    const update = state.queries[2];
    expect(update.text).toContain('"attempts" + 1');
    expect(update.params).toContain(120);
    expect(claimed).toEqual([
      expect.objectContaining({
        id: task.id,
        siteId: task.siteId,
        attempts: 2,
      }),
    ]);
    expect(update.params).toContain(claimed[0].claimToken);
    expect(claimed[0].claimToken).not.toBe(task.claimToken);
  });

  test.each(["complete", "fail"] as const)(
    "%s cannot modify a completed task or a newer claim",
    async (operation) => {
      const state = database();
      if (operation === "complete") await state.repository.complete(task);
      else await state.repository.fail(task, "purge_timeout", 60);
      const query = state.queries[0];
      const where = query.text.split(" where ")[1];
      expect(where).toContain('"id" =');
      expect(where).toContain('"claim_token" =');
      expect(where).toContain('"completed_at" is null');
      expect(query.params.slice(-2)).toEqual([task.id, task.claimToken]);
      expect(query.text).toContain('"claim_token" =');
      expect(query.text).toContain('"lease_until" =');
      if (operation === "fail") {
        expect(query.text).toContain("interval '1 second'");
        expect(query.params).toContain(60);
        expect(query.params).toContain("purge_timeout");
      }
    },
  );

  test("does not write when no task is due", async () => {
    const state = database([[]]);
    expect(await state.repository.claim()).toEqual([]);
    expect(state.queries).toHaveLength(3);
    expect(state.queries.at(-1)?.text).toBe("commit");
  });

  test("does not claim unrelated tasks for an empty immediate-delivery list", async () => {
    const state = database();
    expect(await state.repository.claim([])).toEqual([]);
    expect(state.queries).toEqual([]);
  });

  test("summarizes pending, delayed, and failed invalidations in one query", async () => {
    const state = database([[[4, 2, 1, 900, 3]]]);

    await expect(state.repository.readHealth()).resolves.toEqual({
      pendingCount: 4,
      delayedCount: 2,
      failedCount: 1,
      oldestPendingAgeSeconds: 900,
      maxAttempts: 3,
    });

    expect(state.queries).toHaveLength(1);
    expect(state.queries[0].text).toContain("count(*)");
    expect(state.queries[0].text).toContain('"next_attempt_at" <= now()');
    expect(state.queries[0].text).toContain('"last_error" is not null');
    expect(state.queries[0].text).toContain('"completed_at" is null');
    expect(state.queries[0].text).toContain('min("created_at")');
    expect(state.queries[0].text).toContain('max("attempts")');
  });
});
