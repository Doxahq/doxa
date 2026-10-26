import {
  containerGenerationStageResultSchema,
  type ContainerGenerationStageRequest,
  type ContainerGenerationStageResult,
} from "@doxahq/contracts";
import { PLAN_CACHE_PREFIX } from "@doxahq/contracts/storage-lifecycle";
import { z } from "zod";
import { refreshAgingCacheObject } from "./generation-cache-refresh";
import { sha256Hex } from "./generation-state-store";

/**
 * A plan (analysis, structure and review) depends only on its stage
 * request: the exact source revision, the baseline or seed, the planner
 * model, the fingerprints and the site settings. A later run with the same
 * request reuses the plan, also when an older job made it.
 */
export const PLAN_CACHE_KEY_VERSION = 1;

/** Request fields that name the job or carry secrets, not plan inputs. */
const VOLATILE_REQUEST_FIELDS = new Set([
  "jobId",
  "stageExecutionId",
  "versionId",
  "installationAccessToken",
  "modelApiKey",
  "modelAuthToken",
]);

export type CachedPlanResult = Extract<
  ContainerGenerationStageResult,
  { stage: "plan"; analysisCheckpoint: string }
>;

const planCacheEntrySchema = z.object({
  version: z.literal(PLAN_CACHE_KEY_VERSION),
  createdAt: z.string().datetime(),
  result: containerGenerationStageResultSchema,
}).strict();

export interface GenerationPlanCache {
  get(key: string): Promise<CachedPlanResult | null>;
  put(key: string, result: CachedPlanResult, createdAt: string): Promise<void>;
}

export function isCachedPlanResult(
  result: ContainerGenerationStageResult,
): result is CachedPlanResult {
  return result.stage === "plan" && "analysisCheckpoint" in result;
}

export async function planCacheKey(
  request: ContainerGenerationStageRequest,
): Promise<string> {
  const inputs = Object.fromEntries(
    Object.entries(request).filter(([field]) => !VOLATILE_REQUEST_FIELDS.has(field)),
  );
  const digest = await sha256Hex(stableJson([PLAN_CACHE_KEY_VERSION, inputs]));
  return `${PLAN_CACHE_PREFIX}${digest}.json`;
}

interface PlanCacheBucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: string, options?: R2PutOptions): Promise<R2Object | null>;
}

const PLAN_CACHE_CONTENT_TYPE = "application/json; charset=utf-8";

/** A read or write that fails is a cache miss, never a failed run. */
export function createR2GenerationPlanCache(
  bucket: PlanCacheBucket,
  options: { now?: () => Date } = {},
): GenerationPlanCache {
  const now = options.now ?? (() => new Date());
  return {
    async get(key) {
      try {
        const object = await bucket.get(key);
        if (!object) return null;
        const body = await object.text();
        const parsed = planCacheEntrySchema.safeParse(JSON.parse(body) as unknown);
        if (!parsed.success || !isCachedPlanResult(parsed.data.result)) return null;
        await refreshAgingCacheObject(bucket, {
          key,
          uploaded: object.uploaded,
          body,
          contentType: PLAN_CACHE_CONTENT_TYPE,
        }, now());
        return parsed.data.result;
      } catch {
        return null;
      }
    },
    async put(key, result, createdAt) {
      try {
        await bucket.put(
          key,
          JSON.stringify(planCacheEntrySchema.parse({
            version: PLAN_CACHE_KEY_VERSION,
            createdAt,
            result,
          })),
          { httpMetadata: { contentType: PLAN_CACHE_CONTENT_TYPE } },
        );
      } catch {
        // A plan that is not cached is planned again next time.
      }
    },
  };
}

/** JSON with object keys in sorted order and no undefined fields. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, sortKeys(entry)]),
  );
}
