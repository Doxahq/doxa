import type {
  PrerenderQueueRpc,
  PrerenderTaskPayload,
} from "@doxahq/contracts/docs-prerender-tasks";

/** Dispatch needs the start method only. */
export type PrerenderDispatchQueue = Pick<PrerenderQueueRpc, "start">;

export interface DocsPrerenderDispatchStore {
  claim(ids?: string[]): Promise<PrerenderTaskPayload[]>;
  failDispatch(
    task: PrerenderTaskPayload,
    error: unknown,
  ): Promise<{ status: "accepted" | "stale" }>;
}

export interface DocsPrerenderDispatchResult {
  claimed: number;
  dispatched: number;
  dispatchFailed: number;
}

export async function dispatchDocsPrerenderTasks(
  store: DocsPrerenderDispatchStore,
  queue: PrerenderDispatchQueue | undefined,
  ids?: string[],
): Promise<DocsPrerenderDispatchResult> {
  if (!queue) {
    return { claimed: 0, dispatched: 0, dispatchFailed: 0 };
  }
  const tasks = await store.claim(ids);
  const outcomes = await Promise.all(
    tasks.map((task) => dispatchTask(store, queue, task)),
  );
  return {
    claimed: tasks.length,
    dispatched: outcomes.filter((outcome) => outcome === "dispatched").length,
    dispatchFailed: outcomes.filter((outcome) => outcome === "failed").length,
  };
}

async function dispatchTask(
  store: DocsPrerenderDispatchStore,
  queue: PrerenderDispatchQueue,
  task: PrerenderTaskPayload,
): Promise<"dispatched" | "failed"> {
  try {
    await queue.start(task);
    return "dispatched";
  } catch (error) {
    await store.failDispatch(task, error).catch(() => undefined);
    console.error(
      JSON.stringify({
        event: "docs_prerender_dispatch_failed",
        taskId: task.taskId,
        siteId: task.identity.siteId,
        renderId: task.identity.renderId,
        errorClass: error instanceof Error ? error.name : "UnknownError",
        errorMessage: sanitizeError(error),
      }),
    );
    return "failed";
  }
}

function sanitizeError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "Pre-render dispatch failed.";
  return message
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
