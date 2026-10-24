import {
  containerPlanStageRequestSchema,
  type ContainerGenerationStageRequest,
} from "@doxahq/contracts";
import { describe, expect, test } from "vitest";
import {
  createR2GenerationPlanCache,
  isCachedPlanResult,
  planCacheKey,
  stableJson,
  type CachedPlanResult,
} from "../src/generation-plan-cache";

function request(overrides: Record<string, unknown> = {}): ContainerGenerationStageRequest {
  return containerPlanStageRequestSchema.parse({
    stage: "plan",
    jobId: "11111111-1111-4111-8111-111111111111",
    stageExecutionId: "22222222-2222-4222-8222-222222222222",
    versionId: "33333333-3333-4333-8333-333333333333",
    repositoryFullName: "acme/flagforge",
    installationAccessToken: "ghs_secret",
    modelProvider: "anthropic",
    modelApiKey: "sk-ant-secret",
    model: "claude-sonnet-5-5",
    siteId: "site-1",
    projectSlug: "flagforge",
    projectName: "FlagForge",
    planningFingerprint: "planning-v4:full-prod:120",
    checkoutSpec: {
      kind: "commit",
      baselineRevision: "e".repeat(40),
      targetRevision: "a".repeat(40),
    },
    ...overrides,
  });
}

const plan: CachedPlanResult = {
  stage: "plan",
  analysisCheckpoint: "{\"projectName\":\"FlagForge\"}",
  structureCheckpoint: "{\"sections\":[]}",
  pageIds: ["documentation/overview"],
  pageInputHashes: { "documentation/overview": "b".repeat(64) },
  routeRegistryHash: "c".repeat(64),
  navigation: { sections: [] },
};

class MemoryBucket {
  readonly objects = new Map<string, string>();

  async get(key: string) {
    const value = this.objects.get(key);
    if (value === undefined) return null;
    return { text: async () => value, uploaded: new Date() } as R2ObjectBody;
  }

  async put(key: string, value: string) {
    this.objects.set(key, value);
    return null;
  }
}

describe("plan cache keys", () => {
  test("ignore the job, the version and the secrets", async () => {
    const key = await planCacheKey(request());
    expect(key).toMatch(/^cache\/plans\/[0-9a-f]{64}\.json$/);
    expect(await planCacheKey(request({
      jobId: "44444444-4444-4444-8444-444444444444",
      stageExecutionId: "55555555-5555-4555-8555-555555555555",
      versionId: "66666666-6666-4666-8666-666666666666",
      installationAccessToken: "ghs_other",
      modelApiKey: "sk-ant-other",
    }))).toBe(key);
  });

  test("change with the revision, the planner model, the fingerprint and the site", async () => {
    const key = await planCacheKey(request());
    for (const changed of [
      { checkoutSpec: { kind: "commit", baselineRevision: "e".repeat(40), targetRevision: "d".repeat(40) } },
      { model: "claude-opus-5-5" },
      { planningFingerprint: "planning-v5:full-prod:120" },
      { siteId: "site-2" },
    ]) {
      expect(await planCacheKey(request(changed))).not.toBe(key);
    }
  });

  test("do not depend on field order", () => {
    expect(stableJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }))
      .toBe(stableJson({ a: { d: [1, { y: 2, z: 1 }] }, b: 1 }));
  });
});

describe("plan cache", () => {
  test("returns a stored plan", async () => {
    const cache = createR2GenerationPlanCache(new MemoryBucket());
    await cache.put("cache/plans/a.json", plan, "2026-10-16T00:00:00.000Z");

    expect(await cache.get("cache/plans/a.json")).toEqual(plan);
    expect(await cache.get("cache/plans/missing.json")).toBeNull();
  });

  test("an unreadable entry is a miss", async () => {
    const bucket = new MemoryBucket();
    bucket.objects.set("cache/plans/a.json", "{not json");
    bucket.objects.set("cache/plans/b.json", JSON.stringify({ version: 99, result: plan }));
    const cache = createR2GenerationPlanCache(bucket);

    expect(await cache.get("cache/plans/a.json")).toBeNull();
    expect(await cache.get("cache/plans/b.json")).toBeNull();
  });

  test("only a finished plan is cached, never a merge conflict", () => {
    expect(isCachedPlanResult(plan)).toBe(true);
    expect(isCachedPlanResult({
      stage: "plan",
      outcome: "merge_conflict",
      targetRevision: "a".repeat(40),
      message: "Conflict",
    })).toBe(false);
  });
});

describe("write group requests", () => {
  test("a write request of the largest write group passes the container schema", async () => {
    const { containerGenerationStageRequestSchema } = await import("@doxahq/contracts");
    const { DEFAULT_WRITE_GROUP_SIZE, resolveWriteGroupSize } = await import("../src/generation-workflow-runtime");
    for (const size of [DEFAULT_WRITE_GROUP_SIZE, resolveWriteGroupSize("1000")]) {
      const write = {
        ...request(),
        stage: "write",
        analysisCheckpoint: "{}",
        structureCheckpoint: "{}",
        pageIds: Array.from({ length: size }, (_, index) => `documentation/page-${index}`),
      };
      expect(containerGenerationStageRequestSchema.safeParse(write).success).toBe(true);
    }
  });
});
