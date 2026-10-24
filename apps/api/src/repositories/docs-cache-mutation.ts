import type {
  DocsCacheInvalidation,
  DocsCacheInvalidationRpc,
} from "@doxahq/contracts";
import type { DoxaDb } from "@doxahq/db";
import { DocsCacheInvalidationWorker } from "../services/docs-cache-invalidation";
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
import type { Env } from "../env";

type EnqueueInvalidation = (input: DocsCacheInvalidation) => Promise<void>;
type EnqueuePrerender = (
  input: EnqueuePublicationTasksInput,
) => Promise<void>;

/** The mutation and its invalidation task commit together; delivery is post-commit. */
export async function withDocsCacheInvalidation<T>(
  db: DoxaDb,
  binding: DocsCacheInvalidationRpc | undefined,
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
  await deliverCacheInvalidations(db, binding, ids);
  return result;
}

/** The production pointer, cache purge, and pre-render intent commit together. */
export async function withDocsPublicationEffects<T>(
  db: DoxaDb,
  env: Pick<
    Env,
    | "DOCS_CACHE_INVALIDATOR"
    | "DOCS_BASE_DOMAIN"
    | "DOXA_RENDERER_RELEASE_ID"
    | "DOCS_PREVIEW_GATE_ENABLED"
    | "PRERENDER_QUEUE"
    | "DATABASE_URL"
    | "HYPERDRIVE"
    | "HYPERDRIVE_CACHE_DISABLED"
  >,
  mutate: (
    tx: DocsMutationTransaction,
    enqueueInvalidation: EnqueueInvalidation,
    enqueuePrerender: EnqueuePrerender,
  ) => Promise<T>,
): Promise<T> {
  const invalidationIds: string[] = [];
  const prerenderTaskIds: string[] = [];
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
      },
    ),
  );
  await deliverCacheInvalidations(
    db,
    env.DOCS_CACHE_INVALIDATOR,
    invalidationIds,
  );
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
  binding: DocsCacheInvalidationRpc | undefined,
  ids: string[],
): Promise<void> {
  if (!binding || ids.length === 0) return;
  try {
    await new DocsCacheInvalidationWorker(
      new DocsCacheInvalidationsRepository(db),
      binding,
    ).process(ids);
  } catch {
    // The committed outbox survives failed delivery. Publication must not be
    // reported as failed after its database transaction commits.
    console.warn("Docs cache invalidation remains pending", { taskIds: ids });
  }
}
