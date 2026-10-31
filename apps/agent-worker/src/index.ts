import type {
  GenerateJobMessage,
  InternalApiRpc,
  WorkflowRestartPoint,
} from "@doxahq/contracts";
import { GENERATION_WORKFLOW_RETENTION } from "@doxahq/contracts/storage-lifecycle";
import {
  type AgentContainerBinding,
  type GenerationInternalApi,
} from "@doxahq/generation";
import {
  deleteExpiredGenerationObservability,
} from "./generation-observability";
import type { WriterSlotsDurableObject } from "./writer-slots/durable-object";

export interface Env {
  API: InternalApiRpc;
  GENERATION_WORKFLOW: Workflow<GenerateJobMessage>;
  AGENT_CONTAINER?: AgentContainerBinding;
  DOCS_BUCKET: R2Bucket;
  /** The account-wide writer slot pool. Without it the worker grants every request. */
  WRITER_SLOTS?: DurableObjectNamespace<WriterSlotsDurableObject>;
  AGENT_CONTAINER_URL?: string;
  /** `openrouter` (default) or `anthropic`. The planner and writer models must use that provider's IDs. */
  DOXA_MODEL_PROVIDER?: string;
  OPENROUTER_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  DOXA_AGENT_MODEL?: string;
  DOXA_PLANNER_MODEL?: string;
  DOXA_WRITER_MODEL?: string;
  /** Optional. The last retry of a failing page uses it; the planner model otherwise. */
  DOXA_WRITER_FALLBACK_MODEL?: string;
  DOXA_GENERATION_PROFILE?: "fast-mvp" | "full-prod";
  DOXA_AGENT_PAGE_CONCURRENCY?: string;
  DOXA_WRITE_BATCH_PARALLELISM?: string;
  /** The account-wide writer slot ceiling. Default `DEFAULT_ACCOUNT_WRITER_SLOTS`. */
  DOXA_ACCOUNT_WRITER_SLOTS?: string;
  DOXA_PLAN_STAGE_ENABLED?: string;
  DOXA_PAGE_CACHE_ENABLED?: string;
  /** Pages per write group, one Workflow step each. Default 24. */
  DOXA_WRITE_GROUP_SIZE?: string;
  /** "0" turns off reuse of plans across runs. On by default. */
  DOXA_PLAN_CACHE_ENABLED?: string;
  DOXA_PAGE_CACHE_CROSS_MODEL?: string;
  GENERATION_TIMEOUT_MS?: string;
  GENERATION_IDLE_TIMEOUT_MS?: string;
  GENERATION_OVERALL_TIMEOUT_MS?: string;
  ANALYSIS_STAGE_TIMEOUT_MS?: string;
  STRUCTURE_STAGE_TIMEOUT_MS?: string;
  PAGE_BATCH_TIMEOUT_MS?: string;
  /** Timeout of one template write group. Default 10 minutes. */
  TEMPLATE_PAGE_BATCH_TIMEOUT_MS?: string;
  FINALIZATION_TIMEOUT_MS?: string;
}

export default {
  async queue(batch: MessageBatch<GenerateJobMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        logGeneration("generation_admission_started", message.body);
        const control = await env.API.getGenerationControl();
        if (control.status === "paused") {
          const reason = control.reason ? ` Generation is paused: ${control.reason}` : " Generation is paused.";
          await env.API.markJobCancelled(message.body.jobId, reason.trim());
          await env.API.addJobEvent(message.body.jobId, {
            type: "generation_paused",
            message: reason.trim(),
            source: "worker",
            data: { paused: true },
          });
          logGeneration("generation_paused", message.body, { reason: control.reason ?? null });
          message.ack();
          continue;
        }

        if (message.body.restartFrom) {
          await restartGenerationWorkflow(env, message.body, message.body.restartFrom);
          message.ack();
          continue;
        }

        await env.GENERATION_WORKFLOW.create({
          id: message.body.jobId,
          params: message.body,
          retention: GENERATION_WORKFLOW_RETENTION,
        });
        logGeneration("generation_workflow_admitted", message.body);
        message.ack();
      } catch (error) {
        if (isWorkflowAlreadyExistsError(error) || await workflowInstanceExists(env, message.body.jobId)) {
          logGeneration("generation_workflow_already_admitted", message.body);
          message.ack();
          continue;
        }

        logGenerationError("generation_infrastructure_error", message.body, {
          error: error instanceof Error ? error.message : "Queued generation failed before status update.",
        });
        message.retry();
      }
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(Promise.all([
      runGenerationWatchdog(env),
      deleteExpiredGenerationObservability(env),
    ]).then(() => undefined));
  },

  async fetch(): Promise<Response> {
    return Response.json({ ok: true, service: "doxa-agent-worker" });
  },
};

export async function runGenerationWatchdog(env: Env): Promise<void> {
  const thresholds = generationStaleThresholds(env);
  const staleJobs = await env.API.listStaleGenerationJobs(thresholds);

  for (const job of staleJobs) {
    const message = job.status === "queued"
      ? "Queued generation cancelled by watchdog after waiting too long."
      : "Running generation marked failed by watchdog after timing out.";

    if (job.status === "queued") {
      await env.API.markJobCancelled(job.id, message);
      await env.API.addJobEvent(job.id, {
        type: "watchdog_cancelled",
        message,
        source: "worker",
        data: { elapsedSeconds: job.elapsedSeconds },
      });
    } else if (job.status === "running") {
      await env.API.markJobFailed(job.id, message);
      await env.API.addJobEvent(job.id, {
        type: "watchdog_failed",
        message,
        source: "worker",
        data: { elapsedSeconds: job.elapsedSeconds },
      });
    }

    const destroyed = await requestContainerDestroy(env, job.id);
    await env.API.addJobEvent(job.id, {
      type: destroyed ? "container_destroy_requested" : "container_destroy_unavailable",
      message: destroyed
        ? "Agent container destroy requested by watchdog."
        : "Watchdog could not request agent container destroy from this runtime.",
      source: "worker",
      data: { ok: destroyed },
    });
  }
}

/**
 * Continues a failed run's Workflow instance from its failed step. Every
 * earlier step keeps its result. An instance whose saved state expired
 * cannot continue, so the job fails again with a message that says to
 * start a new run.
 */
export async function restartGenerationWorkflow(
  env: Pick<Env, "API" | "GENERATION_WORKFLOW">,
  message: GenerateJobMessage,
  from: WorkflowRestartPoint,
): Promise<void> {
  try {
    const instance = await env.GENERATION_WORKFLOW.get(message.jobId);
    await instance.restart({ from });
    logGeneration("generation_workflow_restarted", message, { fromStep: from.name });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logGenerationError("generation_workflow_restart_failed", message, { error: reason });
    await env.API.markJobFailed(
      message.jobId,
      "This run could not continue from where it stopped, because its saved steps are gone. Re-run it instead.",
    );
    await env.API.addJobEvent(message.jobId, {
      type: "generation_resume_failed",
      message: "The run could not continue from its failed step.",
      source: "worker",
      data: { fromStep: from.name, reason },
    }).catch(() => undefined);
  }
}

export function isWorkflowAlreadyExistsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /workflow.*(?:already exists|already been created)|instance.*already exists/i.test(message);
}

async function workflowInstanceExists(env: Env, jobId: string): Promise<boolean> {
  try {
    const instance = await env.GENERATION_WORKFLOW.get(jobId);
    const status = await instance.status();
    return status.status !== "unknown";
  } catch {
    return false;
  }
}

function logGeneration(
  eventType: string,
  message: GenerateJobMessage,
  data: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({
    service: "doxa-agent-worker",
    eventType,
    jobId: message.jobId,
    projectId: message.projectId,
    ...data,
  }));
}

function logGenerationError(
  eventType: string,
  message: GenerateJobMessage,
  data: Record<string, unknown> = {},
): void {
  console.error(JSON.stringify({
    service: "doxa-agent-worker",
    eventType,
    jobId: message.jobId,
    projectId: message.projectId,
    ...data,
  }));
}

export function createInternalApiAdapter(api: InternalApiRpc): GenerationInternalApi {
  return {
    getGenerationContext: (projectId) => api.getGenerationContext(projectId),
    createInstallationAccessToken: (installationId) => api.createInstallationAccessToken(installationId),
    markJobRunning: (jobId) => api.markJobRunning(jobId),
    markJobFailed: (jobId, message) => api.markJobFailed(jobId, message),
    markJobCancelled: (jobId, message) => api.markJobCancelled(jobId, message),
    isJobActive: (jobId) => api.isJobActive(jobId),
    getGenerationControl: () => api.getGenerationControl(),
    listStaleGenerationJobs: (input) => api.listStaleGenerationJobs(input),
    addJobEvent: (jobId, type, message, data, source) =>
      api.addJobEvent(jobId, { type, message, data, source }).then(() => undefined),
    publishJobOutput: (input) => api.publishJobOutput(input.jobId, input),
  };
}

function generationStaleThresholds(env: Env) {
  const configuredTimeoutMs = Number(env.GENERATION_OVERALL_TIMEOUT_MS ?? env.GENERATION_TIMEOUT_MS);
  return {
    queuedStaleSeconds: 10 * 60,
    runningStaleSeconds: Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? Math.ceil(configuredTimeoutMs / 1000)
      : 20 * 60,
  };
}

export { GenerationWorkflow } from "./generation-workflow-entrypoint";
export { WriterSlotsDurableObject } from "./writer-slots/durable-object";
export {
  GenerationStateStore,
  createR2GenerationStateStorage,
  generationStateManifestKey,
  generationStatePrefix,
} from "./generation-state-store";

async function requestContainerDestroy(env: Env, jobId: string): Promise<boolean> {
  if (!env.AGENT_CONTAINER) return false;

  try {
    const response = await env.AGENT_CONTAINER.fetch(
      new Request(`https://agent-container.internal/admin/containers/${jobId}/destroy`, {
        method: "POST",
      }),
    );
    return response.ok;
  } catch (err) {
    console.error(JSON.stringify({
      service: "doxa-agent-worker",
      eventType: "container_destroy_failed",
      jobId,
      error: err instanceof Error ? err.message : "request failed",
    }));
    return false;
  }
}
