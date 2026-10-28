import { schema } from "@doxahq/db";
import type { CompleteJobOutputInput } from "@doxahq/contracts";
import { describe, expect, test, vi } from "vitest";

const mock = vi.hoisted(() => ({ createDb: vi.fn() }));
vi.mock("@doxahq/db", async (original) => ({
  ...(await original<typeof import("@doxahq/db")>()),
  createDb: mock.createDb,
}));

import { DocsRepository } from "../../src/repositories/docs";
import { DocsContentRepository } from "../../src/repositories/docs-content";
import { JobsRepository } from "../../src/repositories/jobs";

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
  innerJoin() {
    return this;
  }
  returning() {
    return this;
  }
}

function database(selects: Row[][]) {
  const inserted: Array<{ table: unknown; values: Row }> = [];
  const queries = {
    select: () => new Result(selects.shift() ?? []),
    insert: (table: unknown) => ({
      values: (values: Row) => {
        inserted.push({ table, values });
        return new Result([
          { ...values, id: values.id ?? "new-version", createdAt: new Date() },
        ]);
      },
    }),
    update: () => ({ set: () => new Result([{ sequence: 1 }]) }),
  };
  const db = {
    ...queries,
    transaction: async <T>(
      callback: (tx: typeof queries) => Promise<T>,
    ): Promise<T> => callback(queries),
  };
  mock.createDb.mockReturnValue(db);
  return {
    invalidations: () =>
      inserted
        .filter(
          ({ table, values }) =>
            table === schema.docsCacheInvalidations &&
            !("nextAttemptAt" in values),
        )
        .map(({ values }) => values),
    publications: () =>
      inserted
        .filter(({ table }) => table === schema.docsPublications)
        .map(({ values }) => values),
    versions: () =>
      inserted
        .filter(({ table }) => table === schema.docsVersions)
        .map(({ values }) => values),
  };
}

const site = { id: "site-1", publishedVersionId: "old-version" };
const job = {
  id: "job-1",
  projectId: "project-1",
  status: "running",
  publicationMode: "production",
  targetRevision: "revision",
  sourceTreeHash: null,
  baselineVersionId: null,
  generatorFingerprint: "generator",
};
const completion: CompleteJobOutputInput = {
  publicationMode: "publish",
  versionId: "new-version",
  sourceRevision: "revision",
  sourceTreeHash: "tree",
  baselineVersionId: null,
  generatorFingerprint: "generator",
  artifactPrefix: "sites/site-1/versions/new-version",
  manifestPath: "sites/site-1/versions/new-version/manifest.json",
  generationStatePrefix: "sites/site-1/generation-state/new-version",
  changedSourceCount: 1,
  regeneratedPageCount: 1,
  reusedPageCount: 0,
};

describe("production publication invalidation", () => {
  test("records an invalidation with legacy generation publication", async () => {
    const state = database([
      [job],
      [site],
      [],
      [{ id: "new-version" }],
      [{ id: "old-version" }],
    ]);
    await new DocsRepository({} as never).publishJob({
      jobId: "job-1",
      artifactPrefix: "artifacts",
      manifestPath: "artifacts/manifest.json",
    });
    expect(state.invalidations()).toEqual([
      { id: expect.any(String), siteId: "site-1" },
    ]);
    expect(state.publications()).toEqual([
      expect.objectContaining({
        siteId: site.id,
        versionId: "new-version",
        previousVersionId: site.publishedVersionId,
        kind: "generation",
      }),
    ]);
  });

  test("records an invalidation with revision-aware production completion", async () => {
    const state = database([
      [job],
      [site],
      // Only starter content is published, so the run publishes directly.
      [],
      [],
      [{ id: "new-version" }],
      [{ id: "old-version" }],
    ]);
    await new DocsRepository({} as never).completeJob("job-1", completion, {});
    expect(state.invalidations()).toEqual([
      { id: expect.any(String), siteId: "site-1" },
    ]);
    expect(state.publications()).toHaveLength(1);
  });

  test("stages a production run for review when a person published the site", async () => {
    const state = database([
      [job],
      [site],
      [{ id: "editor-publication" }],
      [],
    ]);
    await new DocsRepository({} as never).completeJob("job-1", completion, {});

    expect(state.versions()).toEqual([
      expect.objectContaining({
        id: "new-version",
        channel: "preview",
        status: "staged",
      }),
    ]);
    expect(state.invalidations()).toEqual([]);
    expect(state.publications()).toEqual([]);
  });

  test("records an invalidation with an editor publish", async () => {
    const state = database([
      [site],
      [],
      [{ id: "new-version" }],
      [{ id: "old-version" }],
    ]);
    await new DocsContentRepository({}).createContentVersion({
      siteId: "site-1",
      baseVersionId: "old-version",
      artifactPrefix: "edited",
      manifestPath: "edited/manifest.json",
      generationStatePrefix: "edited/state",
    });
    expect(state.invalidations()).toEqual([
      { id: expect.any(String), siteId: "site-1" },
    ]);
    expect(state.publications()).toHaveLength(1);
  });

  test("records an invalidation when an older generation is promoted", async () => {
    const state = database([
      [
        {
          job: { ...job, status: "succeeded", docsVersionId: "source-version" },
        },
      ],
      [site],
      [
        {
          id: "source-version",
          artifactPrefix: "source-artifacts",
          channel: "production",
          previewReplacedAt: null,
          artifactsCollectedAt: null,
        },
      ],
      [
        {
          id: "old-version",
          artifactPrefix: "other-artifacts",
          baselineVersionId: null,
        },
      ],
      // The run has no generation review.
      [],
      [],
      [{ id: "new-version" }],
      [{ id: "old-version" }],
    ]);
    expect(
      await new JobsRepository({}).promoteForProject({
        userId: "user-1",
        projectId: "project-1",
        jobId: "job-1",
      }),
    ).toMatchObject({ outcome: "promoted" });
    expect(state.invalidations()).toEqual([
      { id: expect.any(String), siteId: "site-1" },
    ]);
    expect(state.publications()).toHaveLength(1);
  });

  test("does not invalidate when an editor loses the publication race", async () => {
    const state = database([[site]]);
    await expect(
      new DocsContentRepository({}).createContentVersion({
        siteId: "site-1",
        baseVersionId: "stale-version",
        artifactPrefix: "edited",
        manifestPath: "edited/manifest.json",
        generationStatePrefix: "edited/state",
      }),
    ).rejects.toThrow("changed while this branch was open");
    expect(state.invalidations()).toEqual([]);
  });

  test("does not invalidate a blocked promotion", async () => {
    const state = database([
      [{ job: { ...job, docsVersionId: null } }],
      [{ ...site, publishedVersionId: null }],
    ]);
    expect(
      await new JobsRepository({}).promoteForProject({
        userId: "user-1",
        projectId: "project-1",
        jobId: "job-1",
      }),
    ).toMatchObject({ outcome: "blocked" });
    expect(state.invalidations()).toEqual([]);
  });

  test("does not invalidate production when a PR preview is published", async () => {
    const previewJob = {
      ...job,
      publicationMode: "preview",
      sourceProvider: "github",
      changeExternalId: "pr-7",
      changeProposalId: "proposal-7",
    };
    const state = database([
      [previewJob],
      [{ ...site, slug: "demo" }],
      [],
      [
        {
          projectId: "project-1",
          provider: "github",
          externalId: "pr-7",
          displayNumber: 7,
          headRevision: "revision",
          state: "open",
        },
      ],
      ...Array.from({ length: 12 }, () => []),
      [
        {
          id: "channel-7",
          projectId: "project-1",
          siteId: "site-1",
          provider: "github",
          changeExternalId: "pr-7",
          hostname: "demo-pr-7.doxa.page",
          lifecycleState: "active",
          currentVersionId: null,
          expiresAt: null,
        },
      ],
    ]);
    const result = await new DocsRepository({} as never).completeJob(
      "job-1",
      {
        ...completion,
        publicationMode: "preview",
        provider: "github",
        changeExternalId: "pr-7",
        changeNumber: 7,
        expectedHeadRevision: "revision",
        expectedPreviewVersionId: null,
      },
      { DOCS_BASE_DOMAIN: "doxa.page" },
    );
    expect(result).toEqual({
      versionId: "new-version",
      previewUrl: "https://demo-pr-7.doxa.page",
    });
    expect(state.invalidations()).toEqual([]);
  });

  test("does not duplicate invalidation for an idempotent completion", async () => {
    const state = database([
      [{ ...job, status: "succeeded", docsVersionId: "new-version" }],
      [{ ...completion, id: "new-version", channel: "production" }],
    ]);
    expect(
      await new DocsRepository({} as never).completeJob(
        "job-1",
        completion,
        {},
      ),
    ).toEqual({ versionId: "new-version", previewUrl: null });
    expect(state.invalidations()).toEqual([]);
  });
});
