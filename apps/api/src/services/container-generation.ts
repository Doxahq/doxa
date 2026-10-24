import { parseVersionArtifactKey } from "@doxahq/docs-engine";
import { runRealGenerationJob, type ArtifactStore } from "@doxahq/generation";
import type { Env } from "../env";
import {
  createR2DocsContentStore,
  type DocsVersionWriter,
} from "./docs-content/store";
import { createLocalGenerationInternalApi } from "./internal-api";

export function runContainerGeneration(env: Env, input: { jobId: string; projectId: string }) {
  return runRealGenerationJob(input, {
    mode: env.GENERATION_MODE ?? "queue",
    internal: createLocalGenerationInternalApi(env),
    artifacts: createVersionArtifactStore(env.DOCS_BUCKET),
    agentContainerUrl: env.AGENT_CONTAINER_URL,
    openRouterApiKey: env.OPENROUTER_API_KEY,
    model: env.DOXA_AGENT_MODEL,
    generationProfile: env.DOXA_GENERATION_PROFILE ?? "fast-mvp",
    pageConcurrency: positiveNumber(env.DOXA_AGENT_PAGE_CONCURRENCY),
    timeoutMs: positiveNumber(env.GENERATION_TIMEOUT_MS),
    idleTimeoutMs: positiveNumber(env.GENERATION_IDLE_TIMEOUT_MS),
    overallTimeoutMs: positiveNumber(env.GENERATION_OVERALL_TIMEOUT_MS),
    analysisTimeoutMs: positiveNumber(env.ANALYSIS_STAGE_TIMEOUT_MS),
    structureTimeoutMs: positiveNumber(env.STRUCTURE_STAGE_TIMEOUT_MS),
    pageBatchTimeoutMs: positiveNumber(env.PAGE_BATCH_TIMEOUT_MS),
    finalizationTimeoutMs: positiveNumber(env.FINALIZATION_TIMEOUT_MS),
  });
}

/** Collects the files of each version and writes its tree on commit. */
function createVersionArtifactStore(bucket: R2Bucket): ArtifactStore {
  const store = createR2DocsContentStore(bucket);
  const writers = new Map<string, Promise<DocsVersionWriter>>();

  return {
    async put(key, content, contentType) {
      const parts = parseVersionArtifactKey(key);

      if (!parts || !parts.path) {
        throw new Error(`Not a version artifact key: ${key}`);
      }

      let writer = writers.get(parts.prefix);

      if (!writer) {
        writer = store.openVersion({
          siteId: parts.siteId,
          versionId: parts.versionId,
        });
        writers.set(parts.prefix, writer);
      }

      await (await writer).put(parts.path, content, contentType);
    },

    async commit(artifactPrefix) {
      const writer = writers.get(artifactPrefix);

      if (!writer) {
        throw new Error(`No files were written to ${artifactPrefix}.`);
      }

      writers.delete(artifactPrefix);
      await (await writer).commit();
    },
  };
}

function positiveNumber(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
