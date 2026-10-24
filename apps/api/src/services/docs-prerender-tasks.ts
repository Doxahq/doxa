import type { PrerenderQueueRpc } from "@doxahq/contracts/docs-prerender-tasks";

/** Maintenance dispatches work and inspects stored manifests. */
export type PrerenderMaintenanceQueue = Pick<
  PrerenderQueueRpc,
  "start" | "inspect"
>;

import type { Env } from "../env";
import {
  dispatchDocsPrerenderTasks,
  type DocsPrerenderDispatchStore,
} from "../repositories/docs-prerender-delivery";
import { DocsPrerenderTasksRepository } from "../repositories/docs-prerender-tasks";
import type { PrerenderManifestCandidate } from "../repositories/docs-prerender-tasks";

interface DocsPrerenderTaskStore extends DocsPrerenderDispatchStore {
  reconcile(): Promise<{ created: number; obsoleted: number }>;
  readHealth(): Promise<{
    pendingCount: number;
    runningCount: number;
    failedCount: number;
    exhaustedCount: number;
    oldestTaskAgeSeconds: number;
  }>;
  listManifestCandidates(): Promise<PrerenderManifestCandidate[]>;
  markManifestVerified(candidate: PrerenderManifestCandidate): Promise<void>;
  reopenMissingOutput(
    candidate: PrerenderManifestCandidate,
  ): Promise<"reopened" | "stale">;
}

export interface DocsPrerenderMaintenanceResult {
  reconciled: number;
  obsoleted: number;
  manifestsInspected: number;
  manifestsReopened: number;
  manifestInspectionFailed: number;
  claimed: number;
  dispatched: number;
  dispatchFailed: number;
  health: Awaited<ReturnType<DocsPrerenderTaskStore["readHealth"]>>;
}

export class DocsPrerenderTaskMaintenance {
  constructor(
    private readonly store: DocsPrerenderTaskStore,
    private readonly queue: PrerenderMaintenanceQueue | undefined,
  ) {}

  static fromEnv(env: Env): DocsPrerenderTaskMaintenance {
    return new DocsPrerenderTaskMaintenance(
      new DocsPrerenderTasksRepository(env),
      env.PRERENDER_QUEUE,
    );
  }

  async run(): Promise<DocsPrerenderMaintenanceResult> {
    const reconciliation = await this.store.reconcile();
    const manifestReconciliation = await this.reconcileManifests();
    const dispatch = await this.dispatch();
    const health = await this.store.readHealth();
    const result = {
      reconciled: reconciliation.created,
      obsoleted: reconciliation.obsoleted,
      ...manifestReconciliation,
      ...dispatch,
      health,
    };
    const event = {
      event: "docs_prerender_task_health",
      status:
        health.exhaustedCount > 0 ||
        dispatch.dispatchFailed > 0 ||
        manifestReconciliation.manifestInspectionFailed > 0
          ? "degraded"
          : "healthy",
      ...result,
    };
    if (event.status === "degraded") console.warn(JSON.stringify(event));
    else console.info(JSON.stringify(event));
    return result;
  }

  async dispatch(ids?: string[]): Promise<{
    claimed: number;
    dispatched: number;
    dispatchFailed: number;
  }> {
    return dispatchDocsPrerenderTasks(this.store, this.queue, ids);
  }

  private async reconcileManifests(): Promise<{
    manifestsInspected: number;
    manifestsReopened: number;
    manifestInspectionFailed: number;
  }> {
    if (!this.queue) {
      return {
        manifestsInspected: 0,
        manifestsReopened: 0,
        manifestInspectionFailed: 0,
      };
    }
    const candidates = await this.store.listManifestCandidates();
    let manifestsReopened = 0;
    let manifestInspectionFailed = 0;
    for (const candidate of candidates) {
      try {
        const inspection = await this.queue.inspect({
          identity: candidate.identity,
        });
        if (inspection.status === "complete") {
          await this.store.markManifestVerified(candidate);
        } else if (
          (await this.store.reopenMissingOutput(candidate)) === "reopened"
        ) {
          manifestsReopened += 1;
        }
      } catch (error) {
        manifestInspectionFailed += 1;
        console.error(
          JSON.stringify({
            event: "docs_prerender_manifest_inspection_failed",
            taskId: candidate.taskId,
            siteId: candidate.identity.siteId,
            renderId: candidate.identity.renderId,
            errorClass: error instanceof Error ? error.name : "UnknownError",
          }),
        );
      }
    }
    return {
      manifestsInspected: candidates.length,
      manifestsReopened,
      manifestInspectionFailed,
    };
  }
}
