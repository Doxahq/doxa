import { DEFAULT_RETENTION_POLICY } from "@doxahq/contracts/retention-policy";
import {
  RETAINED_BY_POLICY_RECHECK_SECONDS,
  type DocsGenerationStateResource,
  type DocsRetiredVersionResource,
  type StorageGcInspection,
} from "@doxahq/contracts/storage-gc";
import { buildArtifactPrefix } from "@doxahq/docs-engine";
import { describe, expect, test, vi } from "vitest";

import { artifactPrefixOwnerVersionId } from "../../src/repositories/docs-version-retention";
import { createDocsGenerationStateCollector } from "../../src/services/storage-gc/collectors/docs-generation-state";
import { createDocsRetiredVersionCollector } from "../../src/services/storage-gc/collectors/docs-retired-version";
import { REFERENCED_PREVIEW_RECHECK_SECONDS } from "../../src/services/storage-gc/collectors/docs-version-prefix";
import {
  inspectSharedVersionStorage,
  versionRetention,
  type VersionRetentionFacts,
} from "../../src/services/storage-gc/version-retention";

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = new Date("2026-10-16T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);
const siteId = "11111111-1111-4111-8111-111111111111";
const previewId = "22222222-2222-4222-8222-222222222222";
const promotionId = "33333333-3333-4333-8333-333333333333";
const policy = DEFAULT_RETENTION_POLICY;

function preview(overrides: Partial<VersionRetentionFacts> = {}): VersionRetentionFacts {
  return {
    channel: "preview",
    createdAt: daysAgo(40),
    previewReplacedAt: daysAgo(30),
    artifactsCollectedAt: null,
    pointers: [],
    history: null,
    hasSucceededGeneration: true,
    ...overrides,
  };
}

function production(overrides: Partial<VersionRetentionFacts> = {}): VersionRetentionFacts {
  return {
    channel: "production",
    createdAt: daysAgo(200),
    previewReplacedAt: null,
    artifactsCollectedAt: null,
    pointers: [],
    history: { rank: 30, lastPublishedAt: daysAgo(200) },
    hasSucceededGeneration: true,
    ...overrides,
  };
}

describe("version retention decision", () => {
  test("always keeps a version that something points to", () => {
    for (const pointer of [
      "published",
      "preview_channel",
      "branch_base",
      "open_review",
      "active_generation",
    ] as const) {
      expect(
        versionRetention(
          production({ pointers: [pointer], artifactsCollectedAt: NOW }),
          policy,
          NOW,
        ),
      ).toBe("version_is_referenced");
    }
  });

  test("keeps a production version in the rollback window", () => {
    expect(
      versionRetention(
        production({ history: { rank: 3, lastPublishedAt: daysAgo(400) } }),
        policy,
        NOW,
      ),
    ).toBe("rollback_window");
    expect(versionRetention(production(), policy, NOW)).toBeNull();
  });

  test("keeps a replaced preview while it is promotable", () => {
    expect(
      versionRetention(preview({ previewReplacedAt: daysAgo(2) }), policy, NOW),
    ).toBe("promote_window");
    expect(versionRetention(preview(), policy, NOW)).toBeNull();
    expect(
      versionRetention(
        preview({ previewReplacedAt: daysAgo(2), hasSucceededGeneration: false }),
        policy,
        NOW,
      ),
    ).toBeNull();
  });

  test("lets a discarded staged version go", () => {
    expect(
      versionRetention(production({ history: null, createdAt: daysAgo(1) }), policy, NOW),
    ).toBeNull();
  });

  test("applies no policy window to a collected version", () => {
    expect(
      versionRetention(
        production({
          artifactsCollectedAt: daysAgo(1),
          history: { rank: 1, lastPublishedAt: NOW },
        }),
        policy,
        NOW,
      ),
    ).toBeNull();
  });

  test("keeps a shared folder while any row keeps it", () => {
    expect(
      inspectSharedVersionStorage(
        [preview(), production({ history: { rank: 1, lastPublishedAt: daysAgo(1) } })],
        policy,
        NOW,
      ),
    ).toEqual({
      status: "retain",
      reason: "rollback_window",
      recheckAfterSeconds: RETAINED_BY_POLICY_RECHECK_SECONDS,
    });
    expect(
      inspectSharedVersionStorage(
        [preview({ pointers: ["preview_channel"] }), production()],
        policy,
        NOW,
      ),
    ).toEqual({
      status: "retain",
      reason: "version_is_referenced",
      recheckAfterSeconds: REFERENCED_PREVIEW_RECHECK_SECONDS,
    });
    expect(inspectSharedVersionStorage([preview(), production()], policy, NOW)).toEqual({
      status: "collect",
    });
  });
});

describe("artifact prefix owner", () => {
  test("reads the version id of a folder and rejects anything else", () => {
    expect(
      artifactPrefixOwnerVersionId(siteId, buildArtifactPrefix(siteId, previewId)),
    ).toBe(previewId);
    expect(artifactPrefixOwnerVersionId(siteId, `sites/${siteId}/previews/x`)).toBeNull();
    expect(
      artifactPrefixOwnerVersionId(siteId, `${buildArtifactPrefix(siteId, previewId)}/x`),
    ).toBeNull();
    expect(
      artifactPrefixOwnerVersionId(
        siteId,
        buildArtifactPrefix("44444444-4444-4444-8444-444444444444", previewId),
      ),
    ).toBeNull();
  });
});

/**
 * PR preview P1 is promoted: production version V2 reuses P1's folder. A
 * newer push replaces P1. The collector must keep the folder while
 * production keeps V2, and delete it only when neither row is kept.
 */
describe("docs_retired_version collector with a promoted preview", () => {
  function setup() {
    const rows = new Map<string, VersionRetentionFacts>([
      [previewId, preview()],
      [
        promotionId,
        production({
          pointers: ["published"],
          history: { rank: 1, lastPublishedAt: daysAgo(1) },
        }),
      ],
    ]);
    const collected = new Set<string>();
    const store = {
      claimRetiredVersionFolder: vi.fn(
        async (_resource: DocsRetiredVersionResource, now: Date): Promise<StorageGcInspection> => {
          const inspection = inspectSharedVersionStorage([...rows.values()], policy, now);
          if (inspection.status === "collect") {
            for (const id of rows.keys()) collected.add(id);
          }
          return inspection;
        },
      ),
      // V2 stores P1's prefix, so the folder is named by P1.
      findFolderOwner: vi.fn(async () => previewId),
    };
    const keys = [
      `${buildArtifactPrefix(siteId, previewId)}/tree.json`,
      `${buildArtifactPrefix(siteId, promotionId)}/tree.json`,
      `sites/${siteId}/blobs/abc`,
    ];
    const removed: string[] = [];
    const content = {
      listKeys: vi.fn(async (prefix: string) =>
        keys.filter((key) => key.startsWith(prefix) && !removed.includes(key)),
      ),
      removeMany: vi.fn(async (batch: string[]) => {
        removed.push(...batch);
      }),
    };
    const onCollected = vi.fn(async () => undefined);
    const collector = createDocsRetiredVersionCollector({
      versions: store,
      content,
      onCollected,
      now: () => NOW,
    });
    return { rows, collected, collector, removed, onCollected };
  }

  test("keeps production's files after the preview is replaced", async () => {
    const { collector, collected } = setup();

    await expect(collector.inspect({ siteId, versionId: previewId })).resolves.toMatchObject({
      status: "retain",
      reason: "version_is_referenced",
    });
    expect(collected.size).toBe(0);
  });

  test("deletes the shared folder once production no longer keeps the promotion", async () => {
    const { collector, rows, collected, removed, onCollected } = setup();
    rows.set(promotionId, production());

    await expect(collector.inspect({ siteId, versionId: promotionId })).resolves.toEqual({
      status: "collect",
    });
    expect([...collected].sort()).toEqual([previewId, promotionId].sort());
    await expect(collector.collect({ siteId, versionId: promotionId })).resolves.toEqual({
      deletedObjects: 1,
      status: "complete",
    });
    // Only the folder that the stored prefix names; never a blob.
    expect(removed).toEqual([`${buildArtifactPrefix(siteId, previewId)}/tree.json`]);
    expect(onCollected).toHaveBeenCalledWith({ siteId, versionId: previewId });
  });

  test("rejects a resource that is not a version id", () => {
    const { collector } = setup();
    expect(() => collector.parse({ siteId, versionId: "../x" })).toThrow();
    expect(() => collector.parse({ siteId, versionId: previewId, prefix: "sites/" })).toThrow();
  });
});

describe("docs_generation_state collector", () => {
  test("keeps the state while a version can be a baseline", async () => {
    const collector = createDocsGenerationStateCollector({
      versions: {
        inspectGenerationState: async (_resource: DocsGenerationStateResource, now: Date) =>
          inspectSharedVersionStorage(
            [production({ history: { rank: 2, lastPublishedAt: daysAgo(3) } })],
            policy,
            now,
          ),
      },
      objects: { listKeys: async () => [], removeMany: async () => undefined },
      now: () => NOW,
    });

    await expect(collector.inspect({ siteId, versionId: previewId })).resolves.toMatchObject({
      status: "retain",
      reason: "rollback_window",
    });
  });

  test("deletes only the state prefix of the version", async () => {
    const listKeys = vi.fn(async (prefix: string) => [`${prefix}manifest.json`]);
    const removeMany = vi.fn(async () => undefined);
    const collector = createDocsGenerationStateCollector({
      versions: { inspectGenerationState: async () => ({ status: "collect" }) },
      objects: { listKeys, removeMany },
    });

    await expect(collector.collect({ siteId, versionId: previewId })).resolves.toEqual({
      deletedObjects: 1,
      status: "complete",
    });
    expect(listKeys).toHaveBeenCalledWith(
      `sites/${siteId}/generation-state/${previewId}/`,
    );
    expect(removeMany).toHaveBeenCalledWith([
      `sites/${siteId}/generation-state/${previewId}/manifest.json`,
    ]);
  });
});
