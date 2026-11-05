import type { DocsCacheInvalidation } from "@doxahq/contracts";
import type { DocsWarmHint } from "@doxahq/contracts/docs-warm-job";
import type { DoxaDb } from "@doxahq/db";
import { DocsCacheInvalidationWorker } from "../services/docs-cache-invalidation";
import type { DocsResolutionEnv } from "../services/docs-host-resolution";
import {
  DocsCacheInvalidationsRepository,
  enqueueDocsCacheInvalidation,
  type DocsMutationTransaction,
} from "./docs-cache-invalidations";
import {
  enqueuePublicationPrerenderTasks,
  readDocsPrerenderTaskConfig,
  type EnqueuePublicationTasksInput,
} from "./docs-prerender-tasks";
import { dispatchDocsPrerenderTasks } from "./docs-prerender-delivery";
import { DocsPrerenderTasksRepository } from "./docs-prerender-tasks";
import { DocsHostnameSourceRepository } from "./docs-hostname-source";
import { enqueueDocsSearchIndexTask } from "./docs-search-index-tasks";
import {
  startDocsSearchIndexing,
  type DocsSearchIndexingEnv,
} from "../services/docs-search/start-indexing";
import type { Env } from "../env";

type EnqueueInvalidation = (input: DocsCacheInvalidation) => Promise<void>;

/**
 * What post-commit delivery needs: the dispatcher binding, and the resolver's
 * inputs to rewrite the hostname map from the committed state.
 */
export type DocsCacheDeliveryEnv = DocsResolutionEnv &
  Pick<Env, "DOCS_CACHE_INVALIDATOR">;
type EnqueuePrerender = (
  input: EnqueuePublicationTasksInput,
) => Promise<void>;

/** The mutation and its invalidation task commit together; delivery is post-commit. */
export async function withDocsCacheInvalidation<T>(
  db: DoxaDb,
  env: DocsCacheDeliveryEnv,
  mutate: (
    tx: DocsMutationTransaction,
    enqueue: EnqueueInvalidation,
  ) => Promise<T>,
): Promise<T> {
  const ids: string[] = [];
  const result = await db.transaction((tx) =>
    mutate(tx, async (input) => {
      ids.push(await enqueueDocsCacheInvalidation(tx, input));
    }),
  );
  await deliverCacheInvalidations(db, env, ids);
  return result;
}

export interface DocsPublicationEffectsOptions {
  /**
   * Warm-job ordering for this publish (M45): the publisher's pool and the
   * changed pages. Sent only with the immediate post-commit delivery.
   */
  warm?: DocsWarmHint;
}

/**
 * The production pointer, cache purge, pre-render intent, and search index
 * task commit together. Every production publish path passes through here:
 * the dashboard, MCP, agents, generations, restores and domain changes.
 */
export async function withDocsPublicationEffects<T>(
  db: DoxaDb,
  env: Pick<
    Env,
    | "DOCS_CACHE_INVALIDATOR"
    | "DOCS_BASE_DOMAIN"
    | "DOCS_PREVIEW_GATE_ENABLED"
    | "DOXA_RENDERER_RELEASE_ID"
    | "DOCS_PREVIEW_GATE_ENABLED"
    | "PRERENDER_QUEUE"
    | "DATABASE_URL"
    | "HYPERDRIVE"
    | "HYPERDRIVE_CACHE_DISABLED"
  > &
    DocsSearchIndexingEnv,
  mutate: (
    tx: DocsMutationTransaction,
    enqueueInvalidation: EnqueueInvalidation,
    enqueuePrerender: EnqueuePrerender,
  ) => Promise<T>,
  options: DocsPublicationEffectsOptions = {},
): Promise<T> {
  const invalidationIds: string[] = [];
  const prerenderTaskIds: string[] = [];
  const searchTaskIds: string[] = [];
  const prerenderConfig = readDocsPrerenderTaskConfig(env);
  const result = await db.transaction((tx) =>
    mutate(
      tx,
      async (input) => {
        invalidationIds.push(await enqueueDocsCacheInvalidation(tx, input));
      },
      async (input) => {
        prerenderTaskIds.push(
          ...(await enqueuePublicationPrerenderTasks(
            tx,
            prerenderConfig,
            input,
          )),
        );
        const searchTaskId = await enqueueDocsSearchIndexTask(tx, {
          siteId: input.siteId,
          versionId: input.publishedVersionId,
        });
        if (searchTaskId) searchTaskIds.push(searchTaskId);
      },
    ),
  );
  await deliverCacheInvalidations(db, env, invalidationIds, options.warm);
  startDocsSearchIndexing(env, searchTaskIds);
  if (env.PRERENDER_QUEUE && prerenderTaskIds.length > 0) {
    try {
      await dispatchDocsPrerenderTasks(
        new DocsPrerenderTasksRepository(env),
        env.PRERENDER_QUEUE,
        prerenderTaskIds,
      );
    } catch (error) {
      console.warn("Docs pre-render tasks remain pending", {
        taskIds: prerenderTaskIds,
        error: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  return result;
}

async function deliverCacheInvalidations(
  db: DoxaDb,
  env: DocsCacheDeliveryEnv,
  ids: string[],
  warm?: DocsWarmHint,
): Promise<void> {
  if (!env.DOCS_CACHE_INVALIDATOR || ids.length === 0) return;
  try {
    await new DocsCacheInvalidationWorker(
      new DocsCacheInvalidationsRepository(db),
      env.DOCS_CACHE_INVALIDATOR,
      new DocsHostnameSourceRepository(env),
    ).process(ids, warm ? { warm } : {});
  } catch {
    // The committed outbox survives failed delivery. Publication must not be
    // reported as failed after its database transaction commits.
    console.warn("Docs cache invalidation remains pending", { taskIds: ids });
  }
}
