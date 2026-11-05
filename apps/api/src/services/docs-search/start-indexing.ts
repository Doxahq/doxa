import type { Env } from "../../env";

/** Optional: a narrow caller, for example a test, leaves the work to the scheduler. */
export type DocsSearchIndexingEnv = Partial<
  Pick<
    Env,
    | "DOCS_BUCKET"
    | "SEARCH_TYPESENSE_HOST"
    | "SEARCH_TYPESENSE_WRITE_KEY"
    | "DOXA_PROD_SEARCH_PAID_PROJECT_IDS"
  >
>;

/**
 * Starts the work after the publish committed and does not wait for it. The
 * task stays in the database, so the scheduler finishes it if this run stops.
 *
 * Only a deployment with provider credentials runs it. The MCP Worker publishes
 * too, and without credentials it would give a paid site browser search, so it
 * leaves its tasks to the API's scheduler.
 */
export function startDocsSearchIndexing(
  env: DocsSearchIndexingEnv,
  ids: readonly string[],
): void {
  if (ids.length === 0 || !env.DOCS_BUCKET || !env.SEARCH_TYPESENSE_WRITE_KEY) {
    return;
  }
  void runIndexing(env as Env, ids).catch((error: unknown) => {
    console.warn("Docs search index tasks remain pending", {
      taskIds: ids,
      error: error instanceof Error ? error.name : "UnknownError",
    });
  });
}

// Loaded here, because the worker's repository uses the publication module.
async function runIndexing(env: Env, ids: readonly string[]): Promise<void> {
  const { createDocsSearchIndexWorker } = await import("./worker-factory");
  await createDocsSearchIndexWorker(env).run(ids);
}
