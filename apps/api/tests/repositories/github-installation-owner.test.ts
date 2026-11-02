import { schema } from "@doxahq/db";
import { drizzle } from "drizzle-orm/pg-proxy";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * SECURITY REGRESSION GUARDRAIL (SEC-001, C1 in the 2026-10-30 audit).
 * Recording an installation must never move it to another Doxa user. The
 * upsert may change only rows that the same user owns.
 */
const mock = vi.hoisted(() => ({
  createDb: vi.fn(),
  queries: [] as Array<{ sql: string; params: unknown[] }>,
  rows: [] as unknown[][],
}));

vi.mock("@doxahq/db", async (original) => ({
  ...(await original<typeof import("@doxahq/db")>()),
  createDb: mock.createDb,
}));

import { GitHubRepository } from "../../src/repositories/github";

describe("GitHubRepository.recordInstallation", () => {
  beforeEach(() => {
    mock.queries.length = 0;
    mock.rows = [];
    mock.createDb.mockReturnValue(
      drizzle(
        async (sql, params) => {
          mock.queries.push({ sql, params });
          return { rows: mock.rows };
        },
        { schema },
      ),
    );
  });

  test("updates an existing row only when the same user owns it", async () => {
    await new GitHubRepository({} as never).recordInstallation({
      userId: "user-2",
      installationId: "4242",
      accountLogin: "acme",
      accountType: "Organization",
    });

    const [query] = mock.queries;
    expect(query?.sql).toMatch(/on conflict \("installation_id"\) do update set/);
    expect(query?.sql).toMatch(/where "github_installations"\."user_id" = \$\d+/);
    // The update sets no user_id: the owner never changes.
    const updateSet = query?.sql.split("do update set")[1]?.split(" where ")[0] ?? "";
    expect(updateSet).not.toContain("user_id");
    expect(query?.params).toContain("user-2");
  });

  test("returns null when another user owns the installation", async () => {
    mock.rows = [];

    await expect(
      new GitHubRepository({} as never).recordInstallation({
        userId: "user-2",
        installationId: "4242",
        accountLogin: "acme",
        accountType: "Organization",
      }),
    ).resolves.toBeNull();
  });
});

describe("GitHubRepository.removeRepositoriesExcept", () => {
  beforeEach(() => {
    mock.queries.length = 0;
    mock.rows = [];
    mock.createDb.mockReturnValue(
      drizzle(
        async (sql, params) => {
          mock.queries.push({ sql, params });
          return { rows: mock.rows };
        },
        { schema },
      ),
    );
  });

  test("deletes only the rows of that installation that are not kept", async () => {
    mock.rows = [["repository-row-9"]];

    const removed = await new GitHubRepository({} as never).removeRepositoriesExcept("installation-row-1", ["7", "8"]);

    const [query] = mock.queries;
    expect(query?.sql).toMatch(/^delete from "github_repositories" where/);
    expect(query?.sql).toMatch(/"github_repositories"\."installation_id" = \$1/);
    expect(query?.sql).toMatch(/"github_repositories"\."github_repo_id" not in \(\$2, \$3\)/);
    expect(query?.params).toEqual(["installation-row-1", "7", "8"]);
    expect(removed).toBe(1);
  });

  test("deletes every row of that installation when nothing is kept", async () => {
    await new GitHubRepository({} as never).removeRepositoriesExcept("installation-row-1", []);

    const [query] = mock.queries;
    expect(query?.sql).toMatch(/where "github_repositories"\."installation_id" = \$1 returning/);
    expect(query?.sql).not.toContain("not in");
    expect(query?.params).toEqual(["installation-row-1"]);
  });
});
