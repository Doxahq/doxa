import { schema } from "@doxahq/db";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDb: vi.fn(),
}));

vi.mock("@doxahq/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@doxahq/db")>();
  return { ...actual, createDb: mocks.createDb };
});

import {
  ActiveGenerationConflictError,
  JobsRepository,
} from "../../src/repositories/jobs";

describe("JobsRepository production admission", () => {
  beforeEach(() => {
    mocks.createDb.mockReset();
  });

  test("persists immutable source and execution identity for manual jobs", async () => {
    const createdAt = new Date("2026-07-25T12:00:00.000Z");
    const job = {
      id: "11111111-1111-4111-8111-111111111111",
      projectId: "project-1",
      status: "queued" as const,
      docsVersionId: null,
      errorMessage: null,
      eventSequence: 0,
      createdAt,
      updatedAt: createdAt,
    };
    const generationValues = vi.fn(() => ({
      returning: async () => [job],
    }));
    const eventValues = vi.fn(() => ({
      returning: async () => [
        {
          id: "22222222-2222-4222-8222-222222222222",
          jobId: job.id,
          sequence: 1,
          source: "api",
          type: "queued",
          message: "Generation job queued.",
          data: null,
          createdAt,
        },
      ],
    }));
    const database = {
      insert: vi.fn((table: unknown) => ({
        values:
          table === schema.generationJobs ? generationValues : eventValues,
      })),
      update: vi.fn(() => ({
        set: () => ({
          where: () => ({
            returning: async () => [{ sequence: 1 }],
          }),
        }),
      })),
      transaction: vi.fn(),
    };
    database.transaction.mockImplementation(async (callback) =>
      callback(database),
    );
    mocks.createDb.mockReturnValue(database);

    await new JobsRepository({}).create({
      projectId: "project-1",
      userId: "user-1",
      trigger: "manual",
      baselineRevision: "a".repeat(40),
      targetRevision: "b".repeat(40),
      sourceTreeHash: null,
      baselineVersionId: "33333333-3333-4333-8333-333333333333",
      seedVersionId: null,
      plannerModel: "x-ai/grok-4.5:nitro",
      writerModel: "moonshotai/kimi-k2.6:nitro",
      generationProfile: "full-prod",
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      generatorFingerprint: "doxabot-v1:x-ai/grok-4.5:full-prod:100",
    });

    expect(generationValues).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "manual",
        requestedByUserId: "user-1",
        publicationMode: "production",
        baselineRevision: "a".repeat(40),
        targetRevision: "b".repeat(40),
        sourceTreeHash: null,
        baselineVersionId: "33333333-3333-4333-8333-333333333333",
        agentModel: "moonshotai/kimi-k2.6:nitro",
        plannerModel: "x-ai/grok-4.5:nitro",
        writerModel: "moonshotai/kimi-k2.6:nitro",
        planningFingerprint: "planning-v1",
        writingFingerprint: "writing-v1",
        generationProfile: "full-prod",
        generatorFingerprint: "doxabot-v1:x-ai/grok-4.5:full-prod:100",
      }),
    );
  });

  test("returns the active job when Drizzle wraps the concurrency constraint error", async () => {
    const createdAt = new Date("2026-08-28T22:52:26.049Z");
    const activeJob = {
      id: "11111111-1111-4111-8111-111111111111",
      projectId: "project-1",
      status: "running" as const,
      docsVersionId: null,
      errorMessage: null,
      eventSequence: 2,
      createdAt,
      updatedAt: createdAt,
    };
    const postgresError = Object.assign(new Error("duplicate key value"), {
      code: "23505",
      constraint: "generation_jobs_active_concurrency_idx",
    });
    const database = {
      insert: vi.fn(() => ({
        values: () => ({
          returning: async () => {
            throw new DrizzleQueryError(
              "insert into generation_jobs",
              [],
              postgresError,
            );
          },
        }),
      })),
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => [activeJob],
            }),
          }),
        }),
      })),
    };
    mocks.createDb.mockReturnValue(database);

    await expect(
      new JobsRepository({}).create(createProductionJobInput()),
    ).resolves.toEqual({
      outcome: "already_active",
      job: expect.objectContaining({
        id: activeJob.id,
        status: "running",
      }),
    });
  });

  test("reports a conflict when the blocking job ends during admission", async () => {
    const postgresError = Object.assign(new Error("duplicate key value"), {
      code: "23505",
      constraint: "generation_jobs_active_concurrency_idx",
    });
    const database = {
      insert: vi.fn(() => ({
        values: () => ({
          returning: async () => {
            throw new DrizzleQueryError(
              "insert into generation_jobs",
              [],
              postgresError,
            );
          },
        }),
      })),
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => [],
            }),
          }),
        }),
      })),
    };
    mocks.createDb.mockReturnValue(database);

    await expect(
      new JobsRepository({}).create(createProductionJobInput()),
    ).rejects.toBeInstanceOf(ActiveGenerationConflictError);
  });
});

function createProductionJobInput() {
  return {
    projectId: "project-1",
    userId: "user-1",
    trigger: "manual" as const,
    baselineRevision: "a".repeat(40),
    targetRevision: "b".repeat(40),
    sourceTreeHash: null,
    baselineVersionId: "33333333-3333-4333-8333-333333333333",
    seedVersionId: null,
    plannerModel: "x-ai/grok-4.5:nitro",
    writerModel: "moonshotai/kimi-k2.6:nitro",
    generationProfile: "full-prod" as const,
    planningFingerprint: "planning-v1",
    writingFingerprint: "writing-v1",
    generatorFingerprint: "doxabot-v1:x-ai/grok-4.5:full-prod:100",
  };
}

describe("JobsRepository stale generation jobs", () => {
  beforeEach(() => {
    mocks.createDb.mockReset();
  });

  test("running staleness uses the mark-running timestamp even after a recent heartbeat", async () => {
    const jobId = "11111111-1111-4111-8111-111111111111";
    const job = {
      id: jobId,
      projectId: "22222222-2222-4222-8222-222222222222",
      requestedByUserId: "user-1",
      status: "running" as const,
      docsVersionId: null,
      errorMessage: null,
      eventSequence: 2,
      createdAt: new Date(Date.now() - 25 * 60_000),
      updatedAt: new Date(Date.now() - 21 * 60_000),
    };
    const latestHeartbeat = {
      id: "33333333-3333-4333-8333-333333333333",
      jobId,
      sequence: 2,
      source: "worker",
      type: "container_waiting",
      message: "Agent container is still generating docs.",
      data: { elapsedSeconds: 1_200 },
      createdAt: new Date(),
    };
    let selectCall = 0;
    const db = {
      select: vi.fn(() => {
        selectCall += 1;
        if (selectCall === 1) {
          return {
            from: () => ({
              innerJoin: () => ({
                leftJoin: () => ({
                  where: () => ({
                    orderBy: () => ({
                      limit: async () => [
                        {
                          job,
                          projectName: "Doxa",
                          projectSlug: "doxa",
                          repositoryFullName: "doxahq/doxa",
                        },
                      ],
                    }),
                  }),
                }),
              }),
            }),
          };
        }

        return {
          from: () => ({
            where: () => ({
              orderBy: async () => [latestHeartbeat],
            }),
          }),
        };
      }),
    };
    mocks.createDb.mockReturnValue(db);
    const repository = new JobsRepository({} as never);

    const staleJobs = await repository.listStaleJobs({
      queuedStaleSeconds: 10 * 60,
      runningStaleSeconds: 20 * 60,
    });

    expect(staleJobs).toHaveLength(1);
    expect(staleJobs[0]).toMatchObject({
      id: jobId,
      status: "running",
      isStale: true,
    });
  });
});

describe("JobsRepository review-run context", () => {
  beforeEach(() => {
    mocks.createDb.mockReset();
  });

  test("resolves the repository through the persisted change proposal", async () => {
    const joinedTables: unknown[] = [];
    const query = {
      innerJoin: vi.fn((table: unknown) => {
        joinedTables.push(table);
        return query;
      }),
      where: vi.fn(() => query),
      limit: vi.fn(async () => [
        {
          jobId: "11111111-1111-4111-8111-111111111111",
          provider: "github",
          targetRevision: "b".repeat(40),
          externalReviewRunId: null,
          repositoryExternalId: "123456",
          repositoryOwner: "doxahq",
          repositoryName: "doxa",
          installationExternalId: "789",
        },
      ]),
    };
    mocks.createDb.mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => query),
      })),
    });

    const context = await new JobsRepository({}).getReviewRunContext(
      "11111111-1111-4111-8111-111111111111",
    );

    expect(joinedTables).toEqual([
      schema.projects,
      schema.scmChangeProposals,
      schema.githubRepositories,
      schema.githubInstallations,
    ]);
    expect(context).toMatchObject({
      provider: "github",
      repository: {
        externalId: "123456",
        installationExternalId: "789",
      },
    });
  });
});

describe("JobsRepository Doxabot admission", () => {
  beforeEach(() => {
    mocks.createDb.mockReset();
  });

  test("creates the job and links its delivery in one transaction", async () => {
    const jobId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    const createdAt = new Date("2026-07-23T10:00:00.000Z");
    const job = {
      id: jobId,
      projectId,
      status: "queued" as const,
      docsVersionId: null,
      errorMessage: null,
      eventSequence: 0,
      createdAt,
      updatedAt: createdAt,
    };
    const generationValues = vi.fn(() => ({
      onConflictDoNothing: () => ({
        returning: async () => [job],
      }),
    }));
    const eventValues = vi.fn(() => ({
      returning: async () => [
        {
          id: "33333333-3333-4333-8333-333333333333",
          jobId,
          sequence: 1,
          source: "system",
          type: "doxabot_queued",
          message: "Doxabot preview generation queued.",
          data: null,
          createdAt,
        },
      ],
    }));
    const deliverySet = vi.fn(() => ({
      where: () => ({
        returning: async () => [{ id: "delivery-row" }],
      }),
    }));
    const sequenceSet = vi.fn(() => ({
      where: () => ({
        returning: async () => [{ sequence: 1 }],
      }),
    }));
    const transactionDatabase = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ userId: "user-1" }],
          }),
        }),
      })),
      insert: vi.fn((table: unknown) => ({
        values:
          table === schema.generationJobs ? generationValues : eventValues,
      })),
      update: vi.fn((table: unknown) => ({
        set: table === schema.scmWebhookDeliveries ? deliverySet : sequenceSet,
      })),
    };
    const transaction = vi.fn(async (callback) =>
      callback(transactionDatabase),
    );
    mocks.createDb.mockReturnValue({ transaction });

    const result = await new JobsRepository({}).admitDoxabotJob({
      projectId,
      provider: "github",
      sourceInstallationExternalId: "789",
      sourceAuthor: {
        externalId: "1",
        handle: "octocat",
        avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
      },
      changeProposalId: "44444444-4444-4444-8444-444444444444",
      changeExternalId: "987654",
      baselineRevision: "a".repeat(40),
      targetRevision: "b".repeat(40),
      sourceTreeHash: null,
      baselineVersionId: "55555555-5555-4555-8555-555555555555",
      plannerModel: "x-ai/grok-4.5:nitro",
      writerModel: "moonshotai/kimi-k2.6:nitro",
      generationProfile: "full-prod",
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      generatorFingerprint: "generator-v1",
      idempotencyKey: "doxabot-idempotency",
      concurrencyKey: `preview:${projectId}:github:987654`,
      deliveryId: "delivery-1",
    });

    expect(result).toEqual({
      outcome: "created",
      queuePublished: false,
      job: {
        id: jobId,
        projectId,
        status: "queued",
        docsVersionId: null,
        errorMessage: null,
        createdAt: createdAt.toISOString(),
        updatedAt: createdAt.toISOString(),
      },
    });
    expect(transaction).toHaveBeenCalledOnce();
    expect(generationValues).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceInstallationExternalId: "789",
        requestedByUserId: "user-1",
        sourceAuthorExternalId: "1",
        sourceAuthorHandle: "octocat",
        sourceAuthorAvatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
        agentModel: "moonshotai/kimi-k2.6:nitro",
        plannerModel: "x-ai/grok-4.5:nitro",
        writerModel: "moonshotai/kimi-k2.6:nitro",
        planningFingerprint: "planning-v1",
        writingFingerprint: "writing-v1",
        generationProfile: "full-prod",
        generatorFingerprint: "generator-v1",
      }),
    );
    expect(deliverySet).toHaveBeenCalledWith(
      expect.objectContaining({ generationJobId: jobId }),
    );
  });

  test("replays and links an idempotent job in the same transaction", async () => {
    const jobId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    const createdAt = new Date("2026-07-23T10:00:00.000Z");
    const existingJob = {
      id: jobId,
      projectId,
      status: "queued" as const,
      docsVersionId: null,
      errorMessage: null,
      eventSequence: 1,
      createdAt,
      updatedAt: createdAt,
    };
    const deliverySet = vi.fn(() => ({
      where: () => ({
        returning: async () => [{ id: "delivery-row" }],
      }),
    }));
    let selectCall = 0;
    const transactionDatabase = {
      insert: vi.fn(() => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: async () => [],
          }),
        }),
      })),
      select: vi.fn(() => {
        selectCall += 1;
        return {
          from: () => ({
            where: () => ({
              limit: async () =>
                selectCall === 1
                  ? [{ userId: "user-1" }]
                  : selectCall === 2
                    ? [existingJob]
                    : [],
            }),
          }),
        };
      }),
      update: vi.fn(() => ({ set: deliverySet })),
    };
    const transaction = vi.fn(async (callback) =>
      callback(transactionDatabase),
    );
    mocks.createDb.mockReturnValue({ transaction });

    const result = await new JobsRepository({}).admitDoxabotJob({
      projectId,
      provider: "github",
      sourceInstallationExternalId: "789",
      sourceAuthor: {
        externalId: "1",
        handle: "octocat",
        avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
      },
      changeProposalId: "44444444-4444-4444-8444-444444444444",
      changeExternalId: "987654",
      baselineRevision: "a".repeat(40),
      targetRevision: "b".repeat(40),
      sourceTreeHash: null,
      baselineVersionId: "55555555-5555-4555-8555-555555555555",
      plannerModel: "x-ai/grok-4.5:nitro",
      writerModel: "moonshotai/kimi-k2.6:nitro",
      generationProfile: "full-prod",
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      generatorFingerprint: "generator-v1",
      idempotencyKey: "doxabot-idempotency",
      concurrencyKey: `preview:${projectId}:github:987654`,
      deliveryId: "delivery-2",
    });

    expect(result).toMatchObject({
      outcome: "replayed",
      queuePublished: false,
      job: { id: jobId },
    });
    expect(transaction).toHaveBeenCalledOnce();
    expect(deliverySet).toHaveBeenCalledWith(
      expect.objectContaining({ generationJobId: jobId }),
    );
  });
});

describe("JobsRepository review-run claims", () => {
  beforeEach(() => {
    mocks.createDb.mockReset();
  });

  test("keeps a recent creation reservation exclusive", async () => {
    const claimedAt = new Date("2026-07-23T10:04:00.000Z");
    const update = vi.fn(() => updateReturning([]));
    mocks.createDb.mockReturnValue({
      update,
      select: vi.fn(() =>
        selectReviewRunId(
          `pending:${Date.parse("2026-07-23T10:00:00.000Z")}:old-claim`,
        ),
      ),
    });

    const result = await new JobsRepository({}).claimReviewRun({
      jobId: "11111111-1111-4111-8111-111111111111",
      claimToken: "new-claim",
      claimedAt,
    });

    expect(result).toEqual({ outcome: "pending" });
    expect(update).toHaveBeenCalledOnce();
  });

  test("reclaims an expired reservation for provider reconciliation", async () => {
    const claimedAt = new Date("2026-07-23T10:06:00.000Z");
    const updateResults = [
      [],
      [{ id: "11111111-1111-4111-8111-111111111111" }],
    ];
    const update = vi.fn(() => updateReturning(updateResults.shift() ?? []));
    mocks.createDb.mockReturnValue({
      update,
      select: vi.fn(() =>
        selectReviewRunId(
          `pending:${Date.parse("2026-07-23T10:00:00.000Z")}:old-claim`,
        ),
      ),
    });

    const result = await new JobsRepository({}).claimReviewRun({
      jobId: "11111111-1111-4111-8111-111111111111",
      claimToken: "new-claim",
      claimedAt,
    });

    expect(result).toEqual({ outcome: "claimed", reconcile: true });
    expect(update).toHaveBeenCalledTimes(2);
  });
});

function updateReturning(rows: unknown[]) {
  return {
    set: () => ({
      where: () => ({
        returning: async () => rows,
      }),
    }),
  };
}

function selectReviewRunId(externalReviewRunId: string) {
  return {
    from: () => ({
      where: () => ({
        limit: async () => [{ externalReviewRunId }],
      }),
    }),
  };
}

describe("JobsRepository generation actions", () => {
  beforeEach(() => {
    mocks.createDb.mockReset();
  });

  test("promotes by inserting a production clone and moving the site pointer", async () => {
    const job = generationActionJob({ publicationMode: "preview" });
    const site = generationActionSite();
    const sourceVersion = generationActionVersion({
      id: job.docsVersionId,
      channel: "preview",
      artifactPrefix: "sites/site-1/previews/version-1",
    });
    const currentProduction = generationActionVersion({
      id: site.publishedVersionId,
      versionNumber: 6,
      artifactPrefix: "sites/site-1/versions/version-6",
    });
    const selectResults = [
      [{ job }],
      [site],
      [sourceVersion],
      [
        {
          id: currentProduction.id,
          baselineVersionId: currentProduction.baselineVersionId,
          artifactPrefix: currentProduction.artifactPrefix,
        },
      ],
      // The run has no generation review.
      [],
      [{ versionNumber: currentProduction.versionNumber }],
      [{ id: "version-7" }],
      [{ id: currentProduction.id }],
    ];
    const versionValues = vi.fn(() => ({
      returning: async () => [{ id: "version-7" }],
    }));
    const eventValues = vi.fn(() => ({
      returning: async () => [
        {
          id: "event-1",
          jobId: job.id,
          sequence: 1,
          source: "api",
          type: "promoted",
          message: "Generation promoted to production.",
          data: {
            versionId: "version-7",
            previousVersionId: currentProduction.id,
          },
          createdAt: new Date("2026-08-20T12:03:00.000Z"),
        },
      ],
    }));
    const siteSet = vi.fn(() => ({ where: async () => [] }));
    const sequenceSet = vi.fn(() => ({
      where: () => ({ returning: async () => [{ sequence: 1 }] }),
    }));
    const updatedTables: unknown[] = [];
    const transactionDatabase = {
      select: vi.fn(() => selectChain(selectResults.shift() ?? [])),
      insert: vi.fn((table: unknown) => ({
        values:
          table === schema.docsSearchIndexes
            ? () => ({
                onConflictDoUpdate: () => ({
                  returning: async () => [{ id: "search-task" }],
                }),
              })
            : table === schema.docsVersions
              ? versionValues
              : eventValues,
      })),
      update: vi.fn((table: unknown) => {
        updatedTables.push(table);
        return {
          set: table === schema.docsSites ? siteSet : sequenceSet,
        };
      }),
    };
    mocks.createDb.mockReturnValue({
      transaction: vi.fn(async (callback) => callback(transactionDatabase)),
    });

    const result = await new JobsRepository({}).promoteForProject({
      userId: "user-1",
      projectId: job.projectId,
      jobId: job.id,
    });

    expect(result).toEqual({
      outcome: "promoted",
      publishedVersionId: "version-7",
    });
    expect(versionValues).toHaveBeenCalledWith({
      siteId: site.id,
      versionNumber: 7,
      status: "published",
      channel: "production",
      artifactPrefix: sourceVersion.artifactPrefix,
      manifestPath: sourceVersion.manifestPath,
      sourceRevision: sourceVersion.sourceRevision,
      sourceTreeHash: sourceVersion.sourceTreeHash,
      baselineVersionId: sourceVersion.id,
      generatorFingerprint: sourceVersion.generatorFingerprint,
      generationStatePrefix: sourceVersion.generationStatePrefix,
    });
    expect(siteSet).toHaveBeenCalledWith(
      expect.objectContaining({ publishedVersionId: "version-7" }),
    );
    expect(eventValues).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.id,
        type: "promoted",
        data: {
          versionId: "version-7",
          previousVersionId: currentProduction.id,
        },
      }),
    );
    expect(updatedTables).not.toContain(schema.docsVersions);
    expect(transactionDatabase.insert).toHaveBeenCalledWith(
      schema.docsPublications,
    );
    expect(sourceVersion.channel).toBe("preview");
  });

  test("deletes only a non-serving generation row", async () => {
    const job = generationActionJob({ status: "failed" });
    const site = generationActionSite();
    const sourceVersion = generationActionVersion({ id: job.docsVersionId });
    const currentProduction = generationActionVersion({
      id: site.publishedVersionId,
      artifactPrefix: "sites/site-1/versions/current",
    });
    const selectResults = [
      [{ job }],
      [site],
      [sourceVersion],
      [
        {
          id: currentProduction.id,
          baselineVersionId: currentProduction.baselineVersionId,
          artifactPrefix: currentProduction.artifactPrefix,
        },
      ],
      [],
    ];
    const deletedTables: unknown[] = [];
    const transactionDatabase = {
      select: vi.fn(() => selectChain(selectResults.shift() ?? [])),
      delete: vi.fn((table: unknown) => {
        deletedTables.push(table);
        return { where: async () => [] };
      }),
    };
    mocks.createDb.mockReturnValue({
      transaction: vi.fn(async (callback) => callback(transactionDatabase)),
    });

    const result = await new JobsRepository({}).deleteForProject({
      userId: "user-1",
      projectId: job.projectId,
      jobId: job.id,
    });

    expect(result).toEqual({ outcome: "deleted" });
    expect(deletedTables).toEqual([schema.generationJobs]);
    expect(deletedTables).not.toContain(schema.docsVersions);
  });

  test("queues the folder and generation state of a deleted generation", async () => {
    const job = generationActionJob({ status: "failed" });
    const site = generationActionSite();
    const sourceVersion = generationActionVersion({ id: job.docsVersionId });
    const selectResults = [
      [{ job }],
      [site],
      [sourceVersion],
      [],
      [],
      [],
      // The retired version, read in the delete transaction.
      [{ generationStatePrefix: sourceVersion.generationStatePrefix }],
    ];
    const queued: Array<Record<string, unknown>> = [];
    const transactionDatabase = {
      select: vi.fn(() => selectChain(selectResults.shift() ?? [])),
      delete: vi.fn(() => ({ where: async () => [] })),
      insert: vi.fn((table: unknown) => ({
        values: (values: Record<string, unknown>) => ({
          onConflictDoUpdate: () => ({
            returning: async () => {
              if (table === schema.storageGcEntries) queued.push(values);
              return [{ id: `gc-${queued.length}` }];
            },
          }),
        }),
      })),
    };
    mocks.createDb.mockReturnValue({
      transaction: vi.fn(async (callback) => callback(transactionDatabase)),
    });

    await expect(
      new JobsRepository({}).deleteForProject({
        userId: "user-1",
        projectId: job.projectId,
        jobId: job.id,
      }),
    ).resolves.toEqual({ outcome: "deleted" });
    expect(queued).toEqual([
      expect.objectContaining({
        target: "docs_retired_version",
        resource: { siteId: site.id, versionId: job.docsVersionId },
        reason: "generation_deleted",
      }),
      expect.objectContaining({
        target: "docs_generation_state",
        resource: { siteId: site.id, versionId: "version-1" },
        reason: "generation_deleted",
      }),
    ]);
  });
});

function selectChain(rows: unknown[]) {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    for: () => chain,
    orderBy: () => chain,
    limit: async () => rows,
  };
  return chain;
}

function generationActionJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    projectId: "project-1",
    requestedByUserId: "user-1",
    status: "succeeded",
    trigger: "manual",
    publicationMode: "production",
    docsVersionId: "version-1",
    sourceProvider: "github",
    targetRevision: "a".repeat(40),
    errorMessage: null,
    eventSequence: 0,
    createdAt: new Date("2026-08-20T12:00:00.000Z"),
    updatedAt: new Date("2026-08-20T12:02:00.000Z"),
    ...overrides,
  };
}

function generationActionSite() {
  return {
    id: "site-1",
    projectId: "project-1",
    slug: "demo",
    publishedVersionId: "version-current",
    generationBaselineResetAt: null,
    createdAt: new Date("2026-08-20T10:00:00.000Z"),
    updatedAt: new Date("2026-08-20T11:00:00.000Z"),
  };
}

function generationActionVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: "version-1",
    siteId: "site-1",
    versionNumber: 1,
    status: "published",
    channel: "production",
    artifactPrefix: "sites/site-1/versions/version-1",
    manifestPath: "sites/site-1/versions/version-1/manifest.json",
    sourceRevision: "a".repeat(40),
    sourceTreeHash: "b".repeat(40),
    baselineVersionId: null,
    generatorFingerprint: "generator-v1",
    generationStatePrefix: "sites/site-1/generation-state/version-1",
    previewReplacedAt: null,
    artifactsCollectedAt: null,
    createdAt: new Date("2026-08-20T12:00:00.000Z"),
    ...overrides,
  };
}
