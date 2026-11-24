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

function useProxyDb() {
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
}

/**
 * Risk 7: a second Doxa user must not take over a repository record that
 * another user's active installation has. The move happens only inside the
 * upsert's WHERE, so a race cannot pass it. (The same SQL was checked on a
 * real Postgres: another owner gets no row, the same owner or an inactive old
 * installation moves the row.)
 */
describe("GitHubRepository.recordRepository", () => {
  beforeEach(useProxyDb);

  const record = () =>
    new GitHubRepository({} as never).recordRepository({
      installationId: "installation-row-new",
      githubRepoId: "7",
      fullName: "acme/docs",
      owner: "acme",
      name: "docs",
    });

  test("moves a repository only for the same owner or an unusable old installation", async () => {
    await record();

    const [query] = mock.queries;
    const where = query?.sql.split("do update set")[1]?.split(" returning ")[0] ?? "";
    expect(where).toContain('"github_repositories"."installation_id" = $17');
    expect(where).toContain('"github_repositories"."disconnected_at" is not null');
    expect(where).toContain('"old_installation"."id" = "github_repositories"."installation_id"');
    expect(where).toContain('"old_installation"."user_id" = "new_installation"."user_id"');
    expect(where).toContain('"old_installation"."status" <> $19');
    expect(query?.params.slice(16)).toEqual(["installation-row-new", "installation-row-new", "active"]);
  });

  test("returns null when the move is refused", async () => {
    mock.rows = [];

    await expect(record()).resolves.toBeNull();
  });
});

describe("GitHubRepository.transferInstallationOwner", () => {
  beforeEach(useProxyDb);

  const transfer = (toUserId = "user-2") =>
    new GitHubRepository({} as never).transferInstallationOwner({
      installationRowId: "installation-row-1",
      fromUserId: "user-1",
      toUserId,
    });

  test("moves only the owner's row, and only to a user of a shared team", async () => {
    mock.rows = [["user-1"]];

    await expect(transfer()).resolves.toBe("moved");

    const update = mock.queries[1];
    expect(update?.sql).toMatch(/^update "github_installations" set "user_id" = \$1/);
    expect(update?.sql).toContain('"github_installations"."user_id" = $4');
    expect(update?.sql).toContain('inner join "team_members" "to_member" on "from_member"."team_id" = "to_member"."team_id"');
    expect(update?.params).toEqual(["user-2", expect.any(String), "installation-row-1", "user-1", "user-1", "user-2"]);
  });

  test("refuses a target with no shared team", async () => {
    // The select finds the owner; the update then matches no row.
    let call = 0;
    mock.createDb.mockReturnValue(
      drizzle(async (sql, params) => {
        mock.queries.push({ sql, params });
        call += 1;
        return { rows: call === 1 ? [["user-1"]] : [] };
      }, { schema }),
    );

    await expect(transfer("stranger")).resolves.toBe("target_not_allowed");
  });

  test("answers not_found to a user who does not own the installation", async () => {
    mock.rows = [["someone-else"]];

    await expect(transfer()).resolves.toBe("not_found");
    expect(mock.queries).toHaveLength(1);
  });

  test("refuses a move to the owner", async () => {
    mock.rows = [["user-1"]];

    await expect(transfer("user-1")).resolves.toBe("target_not_allowed");
    expect(mock.queries).toHaveLength(1);
  });
});
