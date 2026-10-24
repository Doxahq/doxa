import { schema } from "@doxahq/db";
import { describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDb: vi.fn(),
  enqueuePrerender: vi.fn(async (_input: unknown) => [] as string[]),
}));
vi.mock("@doxahq/db", async (original) => ({
  ...(await original<typeof import("@doxahq/db")>()),
  createDb: mocks.createDb,
}));
vi.mock("../../src/repositories/docs-prerender-tasks", async (original) => ({
  ...(await original<
    typeof import("../../src/repositories/docs-prerender-tasks")
  >()),
  readDocsPrerenderTaskConfig: () => ({}),
  enqueuePublicationPrerenderTasks: (_tx: unknown, _config: unknown, input: unknown) =>
    mocks.enqueuePrerender(input),
}));

import { DocsBranchPublicationRepository } from "../../src/repositories/docs-branch-publication";
import { DocsHistoryRepository } from "../../src/repositories/docs-history";

type Row = Record<string, unknown>;
class Result extends Promise<Row[]> {
  static get [Symbol.species]() {
    return Promise;
  }
  constructor(rows: Row[]) {
    super((resolve) => resolve(rows));
  }
  from() {
    return this;
  }
  innerJoin() {
    return this;
  }
  where() {
    return this;
  }
  orderBy() {
    return this;
  }
  limit() {
    return this;
  }
  for() {
    return this;
  }
  returning() {
    return this;
  }
  onConflictDoUpdate() {
    return this;
  }
}

function database(selects: Row[][]) {
  const inserted: Array<{ table: unknown; values: Row }> = [];
  const deleted: unknown[] = [];
  const updates: Array<{ table: unknown; values: Row }> = [];
  const queries = {
    select: () => new Result(selects.shift() ?? []),
    insert: (table: unknown) => ({
      values: (values: Row) => {
        inserted.push({ table, values });
        return new Result([{ ...values, id: values.id ?? "publication-1" }]);
      },
    }),
    update: (table: unknown) => ({
      set: (values: Row) => {
        updates.push({ table, values });
        return new Result([]);
      },
    }),
    delete: (table: unknown) => {
      deleted.push(table);
      return new Result([]);
    },
  };
  mocks.createDb.mockReturnValue({
    ...queries,
    transaction: async <T>(run: (tx: typeof queries) => Promise<T>) =>
      run(queries),
  });
  return { inserted, deleted, updates };
}

/** A base version that no generation wrote: it has no generation state. */
const editedBase = {
  siteId: "site-1",
  sourceRevision: null,
  sourceTreeHash: null,
  generatorFingerprint: null,
  generationStatePrefix: "sites/site-1/content-versions/base-1",
};

describe("branch publication transactions", () => {
  test("keeps the generation baseline when the editor publishes on a generated version", async () => {
    const state = database([
      [{ siteId: "site-1" }],
      [{ id: "site-1", publishedVersionId: "base-1" }],
      [
        {
          id: "branch-1",
          siteId: "site-1",
          ownerUserId: "user-1",
          kind: "named",
          purpose: "user",
          name: "docs-update",
          baseVersionId: "base-1",
          revision: 2,
        },
      ],
      [{ path: "source/install/index.mdx", kind: "upsert", origin: "editor" }],
      [{ versionNumber: 3 }],
      [
        {
          siteId: "site-1",
          sourceRevision: "a".repeat(40),
          sourceTreeHash: "b".repeat(40),
          generatorFingerprint: "generator",
          generationStatePrefix: "sites/site-1/generation-state/staged-1",
        },
      ],
      [{ id: "new-1" }],
      [{ id: "base-1" }],
    ]);

    await new DocsBranchPublicationRepository({}).publish({
      userId: "user-1",
      projectId: "project-1",
      branch: "branch-1",
      expectedBaseVersionId: "base-1",
      expectedRevision: 2,
      eraseBranch: true,
      versionId: "new-1",
      artifactPrefix: "sites/site-1/versions/new-1",
      manifestPath: "sites/site-1/versions/new-1/manifest.json",
      summary: { changedPageCount: 1 },
    });

    expect(
      state.inserted.find(({ table }) => table === schema.docsVersions)?.values,
    ).toMatchObject({
      sourceRevision: "a".repeat(40),
      sourceTreeHash: "b".repeat(40),
      generatorFingerprint: "generator",
      generationStatePrefix: "sites/site-1/generation-state/staged-1",
    });
    // An edit does not lock the page: only a person's switch in its agent settings does.
    expect(
      state.inserted.filter(({ table }) => table === schema.docsPageOwnership),
    ).toEqual([]);
  });

  test("publishes a branch and records exactly one editor publication", async () => {
    const state = database([
      [{ siteId: "site-1" }],
      [{ id: "site-1", publishedVersionId: "base-1" }],
      [
        {
          id: "branch-1",
          siteId: "site-1",
          ownerUserId: "user-1",
          kind: "named",
          name: "docs-update",
          baseVersionId: "base-1",
          revision: 2,
        },
      ],
      [{ path: "source/index.mdx", kind: "upsert", origin: "editor" }],
      [{ versionNumber: 3 }],
      [editedBase],
      [{ id: "new-1" }],
      [{ id: "base-1" }],
    ]);
    const result = await new DocsBranchPublicationRepository({}).publish({
      userId: "user-1",
      projectId: "project-1",
      branch: "branch-1",
      expectedBaseVersionId: "base-1",
      expectedRevision: 2,
      eraseBranch: true,
      versionId: "new-1",
      artifactPrefix: "sites/site-1/versions/new-1",
      manifestPath: "sites/site-1/versions/new-1/manifest.json",
      summary: { changedPageCount: 1 },
    });
    expect(result).toMatchObject({
      result: { versionId: "new-1", versionNumber: 4, branchErased: true },
      collectEntryIds: [],
    });
    expect(state.updates).toContainEqual({
      table: schema.docsSites,
      values: expect.objectContaining({ publishedVersionId: "new-1" }),
    });
    expect(state.deleted).toContain(schema.docsBranches);
    expect(
      state.inserted.filter(({ table }) => table === schema.docsPublications),
    ).toEqual([
      {
        table: schema.docsPublications,
        values: expect.objectContaining({
          siteId: "site-1",
          versionId: "new-1",
          previousVersionId: "base-1",
          kind: "editor",
          branchName: "docs-update",
          actorUserId: "user-1",
        }),
      },
    ]);
  });

  test("restore moves main and records the target publication", async () => {
    const restoredPublicationId = "88888888-8888-4888-8888-888888888888";
    const state = database([
      [{ siteId: "site-1" }],
      [{ id: "site-1", publishedVersionId: "current-1" }],
      [
        {
          versionId: "old-1",
          status: "published",
          channel: "production",
          artifactsCollectedAt: null,
        },
      ],
      [{ id: "old-1" }],
      [{ id: "current-1" }],
    ]);
    const result = await new DocsHistoryRepository({}).restore({
      userId: "user-1",
      projectId: "project-1",
      publicationId: restoredPublicationId,
      expectedMainVersionId: "current-1",
    });
    expect(result.versionId).toBe("old-1");
    expect(state.updates).toContainEqual({
      table: schema.docsSites,
      values: expect.objectContaining({ publishedVersionId: "old-1" }),
    });
    expect(
      state.inserted.filter(({ table }) => table === schema.docsPublications),
    ).toEqual([
      {
        table: schema.docsPublications,
        values: expect.objectContaining({
          versionId: "old-1",
          previousVersionId: "current-1",
          kind: "restore",
          summary: { restoredPublicationId },
        }),
      },
    ]);
    expect(mocks.enqueuePrerender).toHaveBeenCalledWith({
      siteId: "site-1",
      publishedVersionId: "old-1",
      reason: "restore",
    });
  });

  test("rejects a malformed history cursor before querying publications", async () => {
    database([[{ id: "site-1", publishedVersionId: "current-1" }]]);
    await expect(
      new DocsHistoryRepository({}).list({
        userId: "user-1",
        projectId: "project-1",
        cursor: "bad!cursor",
        limit: 25,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
  });
});
