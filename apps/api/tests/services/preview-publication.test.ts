import { schema } from "@doxahq/db";
import type { CompleteJobOutputInput } from "@doxahq/contracts";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDb: vi.fn(),
  isHostnameAvailable: vi.fn(),
}));

vi.mock("@doxahq/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@doxahq/db")>();
  return { ...actual, createDb: mocks.createDb };
});

vi.mock("../../src/services/docs-namespace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/services/docs-namespace")>();
  return {
    ...actual,
    isHostnameAvailable: mocks.isHostnameAvailable,
  };
});

import { DocsRepository } from "../../src/repositories/docs";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const SITE_ID = "33333333-3333-4333-8333-333333333333";
const PROPOSAL_ID = "44444444-4444-4444-8444-444444444444";
const BASELINE_VERSION_ID = "55555555-5555-4555-8555-555555555555";
const FIRST_VERSION_ID = "66666666-6666-4666-8666-666666666666";
const SECOND_VERSION_ID = "77777777-7777-4777-8777-777777777777";
const BASE_REVISION = "a".repeat(40);
const FIRST_HEAD_REVISION = "b".repeat(40);
const SECOND_HEAD_REVISION = "c".repeat(40);
const FIRST_TREE_HASH = "d".repeat(40);
const SECOND_TREE_HASH = "e".repeat(40);

describe("documentation preview publication", () => {
  beforeEach(() => {
    mocks.createDb.mockReset();
  });

  test("creates the first staged preview without changing production", async () => {
    const state = createState();
    mocks.createDb.mockReturnValue(createDatabase(state));

    const result = await completePreview(state, createPreviewInput());

    expect(result).toEqual({
      versionId: FIRST_VERSION_ID,
      previewUrl: "https://doxa-demo-pr-42.doxa.page",
    });
    expect(state.channel).toMatchObject({
      hostname: "doxa-demo-pr-42.doxa.page",
      currentVersionId: FIRST_VERSION_ID,
    });
    expect(state.versions.at(-1)).toMatchObject({
      id: FIRST_VERSION_ID,
      status: "staged",
      channel: "preview",
      sourceRevision: FIRST_HEAD_REVISION,
      sourceTreeHash: FIRST_TREE_HASH,
    });
    expect(state.site.publishedVersionId).toBe(BASELINE_VERSION_ID);
    expect(state.docsSiteUpdateCount).toBe(0);
  });

  test("advances an existing preview for an updated head", async () => {
    const state = createState({
      targetRevision: SECOND_HEAD_REVISION,
      proposalHeadRevision: SECOND_HEAD_REVISION,
      channelVersionId: FIRST_VERSION_ID,
    });
    mocks.createDb.mockReturnValue(createDatabase(state));

    const result = await completePreview(
      state,
      createPreviewInput({
        versionId: SECOND_VERSION_ID,
        sourceRevision: SECOND_HEAD_REVISION,
        sourceTreeHash: SECOND_TREE_HASH,
        expectedHeadRevision: SECOND_HEAD_REVISION,
        expectedPreviewVersionId: FIRST_VERSION_ID,
      }),
    );

    expect(result.versionId).toBe(SECOND_VERSION_ID);
    expect(state.channel?.currentVersionId).toBe(SECOND_VERSION_ID);
    expect(state.site.publishedVersionId).toBe(BASELINE_VERSION_ID);
    // A replaced generation preview can still be promoted, and a promotion
    // serves the files of that preview. It is never queued for the branch
    // preview collector. The retired-version collector applies the promote
    // window and the shared-folder rule when it inspects the entry.
    expect(state.versionUpdates).toEqual([
      { previewReplacedAt: expect.any(Date) },
    ]);
    expect(state.gcEntries.map((entry) => entry.target)).toEqual([
      "docs_retired_version",
      "docs_generation_state",
    ]);
    expect(state.gcEntries[0]).toMatchObject({
      resourceKey: `${SITE_ID}/${FIRST_VERSION_ID}`,
      reason: "preview_replaced",
    });
    expect(
      state.gcEntries.some((entry) => entry.target === "docs_preview_version"),
    ).toBe(false);
  });

  test("replays duplicate completion without another version", async () => {
    const state = createState();
    mocks.createDb.mockReturnValue(createDatabase(state));
    const input = createPreviewInput();

    const first = await completePreview(state, input);
    const second = await completePreview(state, input);

    expect(second).toEqual(first);
    expect(
      state.versions.filter((version) => version.id === FIRST_VERSION_ID),
    ).toHaveLength(1);
    expect(state.events).toHaveLength(1);
  });

  test("rejects stale late completion and retains the newer preview", async () => {
    const state = createState({
      channelVersionId: SECOND_VERSION_ID,
      casSucceeds: false,
    });
    mocks.createDb.mockReturnValue(createDatabase(state));

    await expect(
      completePreview(
        state,
        createPreviewInput({
          expectedPreviewVersionId: FIRST_VERSION_ID,
        }),
      ),
    ).rejects.toThrow("superseded before completion");

    expect(state.channel?.currentVersionId).toBe(SECOND_VERSION_ID);
    expect(
      state.versions.some((version) => version.id === FIRST_VERSION_ID),
    ).toBe(false);
    expect(state.site.publishedVersionId).toBe(BASELINE_VERSION_ID);
  });

  test("uses a deterministic suffix when the preferred hostname is taken", async () => {
    const state = createState({
      hostnameCollisions: new Set(["doxa-demo-pr-42.doxa.page"]),
    });
    mocks.createDb.mockReturnValue(createDatabase(state));

    const result = await completePreview(state, createPreviewInput());

    expect(result.previewUrl).toMatch(
      /^https:\/\/doxa-demo-pr-42-[a-f0-9]{8}\.doxa\.page$/,
    );
    expect(state.channel?.hostname).toBe(
      result.previewUrl?.replace("https://", ""),
    );
  });

  test("rejects a changed pull-request head before moving any pointer", async () => {
    const state = createState({
      proposalHeadRevision: SECOND_HEAD_REVISION,
    });
    mocks.createDb.mockReturnValue(createDatabase(state));

    await expect(completePreview(state, createPreviewInput())).rejects.toThrow(
      "pull request changed",
    );

    expect(state.channel).toBeNull();
    expect(state.site.publishedVersionId).toBe(BASELINE_VERSION_ID);
    expect(state.docsSiteUpdateCount).toBe(0);
  });
});

describe("revision-aware production publication", () => {
  beforeEach(() => {
    mocks.createDb.mockReset();
  });

  test("publishes the version while retaining its compatible generation state identity", async () => {
    const state = createState();
    Object.assign(state.job, {
      trigger: "manual",
      publicationMode: "production",
      sourceProvider: null,
      sourceInstallationExternalId: null,
      changeProposalId: null,
      changeExternalId: null,
    });
    mocks.createDb.mockReturnValue(createDatabase(state));
    const artifactPrefix = `sites/${SITE_ID}/versions/${FIRST_VERSION_ID}`;

    const result = await new DocsRepository(createRepositoryEnv()).completeJob(
      JOB_ID,
      {
        publicationMode: "publish",
        versionId: FIRST_VERSION_ID,
        artifactPrefix,
        manifestPath: `${artifactPrefix}/manifest.json`,
        generationStatePrefix: `sites/${SITE_ID}/generation-state/${FIRST_VERSION_ID}`,
        sourceRevision: FIRST_HEAD_REVISION,
        sourceTreeHash: FIRST_TREE_HASH,
        baselineVersionId: BASELINE_VERSION_ID,
        generatorFingerprint: "doxabot-v1",
        changedSourceCount: 1,
        regeneratedPageCount: 2,
        reusedPageCount: 3,
      },
      {
        DOCS_BASE_DOMAIN: "doxa.page",
        DOCS_RENDERER_BASE_URL: undefined,
      },
    );

    expect(result).toEqual({
      versionId: FIRST_VERSION_ID,
      previewUrl: null,
    });
    expect(state.site.publishedVersionId).toBe(FIRST_VERSION_ID);
    expect(state.versions.at(-1)).toMatchObject({
      id: FIRST_VERSION_ID,
      status: "published",
      channel: "production",
      sourceRevision: FIRST_HEAD_REVISION,
      sourceTreeHash: FIRST_TREE_HASH,
      generatorFingerprint: "doxabot-v1",
      generationStatePrefix: `sites/${SITE_ID}/generation-state/${FIRST_VERSION_ID}`,
    });
  });
});

async function completePreview(
  state: TestState,
  input: CompleteJobOutputInput,
) {
  mocks.isHostnameAvailable.mockImplementation(
    async (_lookup: unknown, candidate: { hostname: string | null }) =>
      candidate.hostname !== null &&
      candidate.hostname !== state.channel?.hostname &&
      !state.hostnameCollisions.has(candidate.hostname),
  );

  return new DocsRepository(createRepositoryEnv()).completeJob(JOB_ID, input, {
    DOCS_BASE_DOMAIN: "doxa.page",
    DOCS_RENDERER_BASE_URL: undefined,
  });
}

function createPreviewInput(
  overrides: Partial<
    Extract<CompleteJobOutputInput, { publicationMode: "preview" }>
  > = {},
): Extract<CompleteJobOutputInput, { publicationMode: "preview" }> {
  const versionId = overrides.versionId ?? FIRST_VERSION_ID;
  const artifactPrefix = `sites/${SITE_ID}/versions/${versionId}`;
  return {
    publicationMode: "preview",
    versionId,
    artifactPrefix,
    manifestPath: `${artifactPrefix}/manifest.json`,
    generationStatePrefix: `sites/${SITE_ID}/generation-state/${versionId}`,
    sourceRevision: FIRST_HEAD_REVISION,
    sourceTreeHash: FIRST_TREE_HASH,
    baselineVersionId: BASELINE_VERSION_ID,
    generatorFingerprint: "doxabot-v1",
    changedSourceCount: 1,
    regeneratedPageCount: 1,
    reusedPageCount: 2,
    provider: "github",
    changeExternalId: "pull-request-42",
    changeNumber: 42,
    expectedHeadRevision: FIRST_HEAD_REVISION,
    expectedPreviewVersionId: null,
    ...overrides,
  };
}

interface TestState {
  job: Record<string, unknown> & {
    status: "queued" | "running" | "succeeded";
    docsVersionId: string | null;
    eventSequence: number;
  };
  site: Record<string, unknown> & {
    publishedVersionId: string | null;
  };
  proposal: Record<string, unknown>;
  versions: Array<Record<string, unknown> & { id: string }>;
  channel: PreviewChannelRow | null;
  events: Array<Record<string, unknown>>;
  gcEntries: Array<Record<string, unknown>>;
  versionUpdates: Array<Record<string, unknown>>;
  hostnameCollisions: Set<string>;
  casSucceeds: boolean;
  docsSiteUpdateCount: number;
}

interface PreviewChannelRow {
  id: string;
  projectId: string;
  siteId: string;
  provider: "github";
  changeExternalId: string;
  hostname: string;
  currentVersionId: string | null;
  lifecycleState: "active";
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function createState(
  input: {
    targetRevision?: string;
    proposalHeadRevision?: string;
    channelVersionId?: string | null;
    hostnameCollisions?: Set<string>;
    casSucceeds?: boolean;
  } = {},
): TestState {
  const now = new Date("2026-07-23T12:00:00.000Z");
  const channelVersionId = input.channelVersionId ?? null;
  return {
    job: {
      id: JOB_ID,
      projectId: PROJECT_ID,
      status: "running",
      trigger: "doxabot",
      publicationMode: "preview",
      docsVersionId: null,
      sourceProvider: "github",
      sourceInstallationExternalId: "installation-1",
      changeProposalId: PROPOSAL_ID,
      changeExternalId: "pull-request-42",
      baselineRevision: BASE_REVISION,
      targetRevision: input.targetRevision ?? FIRST_HEAD_REVISION,
      sourceTreeHash: null,
      baselineVersionId: BASELINE_VERSION_ID,
      generatorFingerprint: "doxabot-v1",
      eventSequence: 0,
    },
    site: {
      id: SITE_ID,
      projectId: PROJECT_ID,
      slug: "doxa-demo",
      publishedVersionId: BASELINE_VERSION_ID,
    },
    proposal: {
      id: PROPOSAL_ID,
      projectId: PROJECT_ID,
      provider: "github",
      externalId: "pull-request-42",
      displayNumber: 42,
      headRevision: input.proposalHeadRevision ?? FIRST_HEAD_REVISION,
      state: "open",
    },
    versions: [
      {
        id: BASELINE_VERSION_ID,
        siteId: SITE_ID,
        versionNumber: 1,
        status: "published",
        channel: "production",
        artifactPrefix: `sites/${SITE_ID}/versions/${BASELINE_VERSION_ID}`,
        manifestPath: `sites/${SITE_ID}/versions/${BASELINE_VERSION_ID}/manifest.json`,
        sourceRevision: BASE_REVISION,
        sourceTreeHash: BASE_REVISION,
        baselineVersionId: null,
        generatorFingerprint: "doxabot-v1",
        generationStatePrefix: `sites/${SITE_ID}/generation-state/${BASELINE_VERSION_ID}`,
      },
    ],
    channel:
      channelVersionId === null
        ? null
        : {
            id: "88888888-8888-4888-8888-888888888888",
            projectId: PROJECT_ID,
            siteId: SITE_ID,
            provider: "github",
            changeExternalId: "pull-request-42",
            hostname: "doxa-demo-pr-42.doxa.page",
            currentVersionId: channelVersionId,
            lifecycleState: "active",
            expiresAt: null,
            createdAt: now,
            updatedAt: now,
          },
    events: [],
    gcEntries: [],
    versionUpdates: [],
    hostnameCollisions: input.hostnameCollisions ?? new Set(),
    casSucceeds: input.casSucceeds ?? true,
    docsSiteUpdateCount: 0,
  };
}

function createDatabase(state: TestState) {
  const transaction = vi.fn(async (callback) => {
    const snapshot = structuredClone(state);
    try {
      return await callback(createTransaction(state));
    } catch (error) {
      restoreState(state, snapshot);
      throw error;
    }
  });
  return { transaction };
}

function createTransaction(state: TestState) {
  return {
    select: vi.fn(() => createSelectQuery(state)),
    insert: vi.fn((table: unknown) => createInsertQuery(state, table)),
    update: vi.fn((table: unknown) => createUpdateQuery(state, table)),
  };
}

function createSelectQuery(state: TestState) {
  let table: unknown;
  let ordered = false;
  const query = {
    from(selectedTable: unknown) {
      table = selectedTable;
      return query;
    },
    where() {
      return query;
    },
    for() {
      return query;
    },
    orderBy() {
      ordered = true;
      return query;
    },
    async limit() {
      if (table === schema.generationJobs) {
        return [state.job];
      }
      if (table === schema.docsSites) {
        return [state.site];
      }
      if (table === schema.scmChangeProposals) {
        return [state.proposal];
      }
      if (table === schema.docsPreviewChannels) {
        return state.channel ? [state.channel] : [];
      }
      if (table === schema.docsVersions) {
        if (ordered) {
          return [state.versions.at(-1)];
        }
        const requestedVersionId =
          state.job.status === "succeeded"
            ? state.job.docsVersionId
            : BASELINE_VERSION_ID;
        return state.versions.filter(
          (version) => version.id === requestedVersionId,
        );
      }
      return [];
    },
  };
  return query;
}

function createInsertQuery(state: TestState, table: unknown) {
  return {
    values(values: Record<string, unknown>) {
      if (table === schema.docsVersions) {
        return {
          async returning() {
            const id = values.id;
            if (typeof id !== "string") {
              throw new Error("Test docs version requires an id.");
            }
            const version = {
              ...values,
              id,
              createdAt: new Date(),
            };
            state.versions.push(version);
            return [version];
          },
        };
      }
      if (table === schema.docsPreviewChannels) {
        return {
          onConflictDoNothing() {
            return {
              async returning() {
                const hostname = String(values.hostname);
                if (state.channel || state.hostnameCollisions.has(hostname)) {
                  return [];
                }
                state.channel = {
                  id: "88888888-8888-4888-8888-888888888888",
                  projectId: String(values.projectId),
                  siteId: String(values.siteId),
                  provider: "github",
                  changeExternalId: String(values.changeExternalId),
                  hostname,
                  currentVersionId: null,
                  lifecycleState: "active",
                  expiresAt: null,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                };
                return [state.channel];
              },
            };
          },
        };
      }
      if (table === schema.storageGcEntries) {
        return {
          onConflictDoUpdate() {
            return {
              async returning() {
                state.gcEntries.push(values);
                return [{ id: `gc-${state.gcEntries.length}` }];
              },
            };
          },
        };
      }
      return {
        async returning() {
          const event = {
            id: `event-${state.events.length + 1}`,
            createdAt: new Date(),
            ...values,
          };
          state.events.push(event);
          return [event];
        },
      };
    },
  };
}

function createUpdateQuery(state: TestState, table: unknown) {
  return {
    set(values: Record<string, unknown>) {
      return {
        where() {
          if (table === schema.docsPreviewChannels) {
            return {
              async returning() {
                if (!state.channel || !state.casSucceeds) {
                  return [];
                }
                state.channel.currentVersionId = String(
                  values.currentVersionId,
                );
                return [{ id: state.channel.id }];
              },
            };
          }
          if (table === schema.docsVersions) {
            state.versionUpdates.push(values);
            return {};
          }
          if (table === schema.docsSites) {
            state.docsSiteUpdateCount += 1;
            state.site.publishedVersionId = String(values.publishedVersionId);
            return {};
          }
          if (table === schema.generationJobs) {
            if ("status" in values) {
              Object.assign(state.job, values);
              return {};
            }
            state.job.eventSequence += 1;
            return {
              async returning() {
                return [
                  {
                    sequence: state.job.eventSequence,
                  },
                ];
              },
            };
          }
          return {};
        },
      };
    },
  };
}

function restoreState(state: TestState, snapshot: TestState): void {
  state.job = snapshot.job;
  state.site = snapshot.site;
  state.proposal = snapshot.proposal;
  state.versions = snapshot.versions;
  state.channel = snapshot.channel;
  state.events = snapshot.events;
  state.gcEntries = snapshot.gcEntries;
  state.versionUpdates = snapshot.versionUpdates;
  state.hostnameCollisions = snapshot.hostnameCollisions;
  state.casSucceeds = snapshot.casSucceeds;
  state.docsSiteUpdateCount = snapshot.docsSiteUpdateCount;
}

function createRepositoryEnv() {
  return {
    DATABASE_URL: "postgres://unused",
  } as never;
}
