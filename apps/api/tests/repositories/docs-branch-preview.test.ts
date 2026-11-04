import { schema } from "@doxahq/db";
import { describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDb: vi.fn(),
  enqueueOrphan: vi.fn(async (_db: unknown, _resource: unknown) => "gc-1"),
  enqueuePreview: vi.fn(
    async (_db: unknown, _resource: unknown, _reason: unknown) => "gc-2",
  ),
}));
vi.mock("@doxahq/db", async (original) => ({
  ...(await original<typeof import("@doxahq/db")>()),
  createDb: mocks.createDb,
}));
vi.mock("../../src/repositories/docs-version-gc-entries", () => ({
  enqueueDocsOrphanVersionPrefix: mocks.enqueueOrphan,
  enqueueDocsPreviewVersion: mocks.enqueuePreview,
}));
vi.mock("../../src/repositories/preview-channels", () => ({
  createChannelHostnameCandidates: async () => ["example-br-feature.doxa.page"],
  createRandomHex: () => "0123456789abcdef",
  ensureBranchPreviewChannelWithCandidates: async () => ({
    id: "channel-1",
    hostname: "example-br-feature.doxa.page",
    currentVersionId: "99999999-9999-4999-8999-999999999999",
  }),
  compareAndSetPreviewVersion: async () => true,
}));
vi.mock("../../src/services/docs-namespace", () => ({
  createDocsNamespaceLookup: () => ({}),
  isHostnameAvailable: async () => true,
}));

import { DocsBranchPreviewRepository } from "../../src/repositories/docs-branch-preview";

const userId = "user-1";
const projectId = "project-1";
const siteId = "33333333-3333-4333-8333-333333333333";
const branchId = "44444444-4444-4444-8444-444444444444";
const baseVersionId = "55555555-5555-4555-8555-555555555555";
const versionId = "66666666-6666-4666-8666-666666666666";

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
}

function database(selects: Row[][]) {
  const state = {
    inTransaction: false,
    inserted: [] as Array<{ table: unknown; values: Row }>,
    updates: [] as Array<{ table: unknown; values: Row }>,
  };
  const queries = {
    select: () => new Result(selects.shift() ?? []),
    insert: (table: unknown) => ({
      values: async (values: Row) => {
        state.inserted.push({ table, values });
      },
    }),
    update: (table: unknown) => ({
      set: (values: Row) => {
        state.updates.push({ table, values });
        return new Result([]);
      },
    }),
  };
  mocks.createDb.mockReturnValue({
    ...queries,
    transaction: async <T>(run: (tx: typeof queries) => Promise<T>) => {
      state.inTransaction = true;
      try {
        return await run(queries);
      } finally {
        state.inTransaction = false;
      }
    },
  });
  return state;
}

function branchRow(revision: number, previewRevision: number | null): Row {
  const now = new Date("2026-09-24T00:00:00.000Z");
  return {
    id: branchId,
    siteId,
    kind: "named",
    name: "feature",
    ownerUserId: userId,
    baseVersionId,
    createdFromBranchId: null,
    createdBy: { kind: "user" },
    revision,
    previewRevision,
    createdAt: now,
    updatedAt: now,
  };
}

function snapshotRows(revision: number): Row[][] {
  return [
    [{ siteId, projectName: "Example", projectSlug: "example" }],
    [branchRow(revision, null)],
    [{ artifactPrefix: `sites/${siteId}/versions/${baseVersionId}` }],
    [],
    [
      {
        currentVersionId: "99999999-9999-4999-8999-999999999999",
        updatedAt: new Date("2026-09-24T00:00:00.000Z"),
      },
    ],
  ];
}

function buildInput(materialize: () => Promise<{ artifactPrefix: string; manifestPath: string }>) {
  return {
    userId,
    projectId,
    branch: branchId,
    versionId,
    docsBaseDomain: "doxa.page",
    materialize,
  };
}

describe("branch preview repository", () => {
  test("writes the artifacts while no transaction holds the site lock", async () => {
    const state = database([
      ...snapshotRows(3),
      [{ siteId, projectName: "Example", projectSlug: "example" }],
      [{ id: siteId }],
      [branchRow(4, null)],
      [{ versionNumber: 2 }],
    ]);
    const materialize = vi.fn(async () => {
      expect(state.inTransaction).toBe(false);
      return {
        artifactPrefix: `sites/${siteId}/versions/${versionId}`,
        manifestPath: `sites/${siteId}/versions/${versionId}/manifest.json`,
      };
    });

    const result = await new DocsBranchPreviewRepository(
      {},
      () => new Date("2026-09-25T00:00:00.000Z"),
    ).build(buildInput(materialize));

    expect(result).toEqual({
      hostname: "example-br-feature.doxa.page",
      versionId,
    });
    expect(materialize).toHaveBeenCalledOnce();
    expect(mocks.enqueueOrphan).toHaveBeenCalledWith(expect.anything(), {
      siteId,
      versionId,
    });
    // Previews have their own sequence, so the published one has no gaps.
    expect(state.inserted).toContainEqual({
      table: schema.docsVersions,
      values: expect.objectContaining({
        id: versionId,
        channel: "preview",
        versionNumber: 3,
      }),
    });
    // The preview records the revision that was built, not a later one.
    expect(state.updates).toContainEqual({
      table: schema.docsBranches,
      values: expect.objectContaining({ previewRevision: 3 }),
    });
  });

  test("rejects a build that a newer preview already replaced", async () => {
    const state = database([
      ...snapshotRows(3),
      [{ siteId, projectName: "Example", projectSlug: "example" }],
      [{ id: siteId }],
      [branchRow(5, 5)],
    ]);

    await expect(
      new DocsBranchPreviewRepository(
        {},
        () => new Date("2026-09-25T00:00:00.000Z"),
      ).build(
        buildInput(async () => ({
          artifactPrefix: `sites/${siteId}/versions/${versionId}`,
          manifestPath: `sites/${siteId}/versions/${versionId}/manifest.json`,
        })),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(state.inserted).toEqual([]);
  });
});
