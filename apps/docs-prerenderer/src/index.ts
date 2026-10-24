import type { PrerenderIdentity } from "@doxahq/contracts/docs-prerender";
import {
  docsPrerenderRenderResourceSchema,
  type StorageGcCollection,
} from "@doxahq/contracts/storage-gc";
import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";

import {
  validateIdentityForRelease,
  validateTaskForRelease,
  type PrerenderTaskPayload,
} from "./task-contract";
import type { Env } from "./runtime-bindings";
import { createBucketAdapter } from "./runtime-bindings";
import { collectPrerenderRender } from "./storage-collector";
import { inspectPrerenderManifest } from "./storage-writer";

export { DocsPrerenderWorkflow } from "./workflow-entrypoint";
export { validateTaskForRelease } from "./task-contract";
export type { Env, PrerenderRendererService } from "./runtime-bindings";

export class PrerenderQueue extends WorkerEntrypoint<Env> {
  async start(input: unknown): Promise<{
    status: "accepted";
    workflowId: string;
  }> {
    const task = validateTaskForRelease(
      input,
      this.env.DOXA_RENDERER_RELEASE_ID,
    );
    const workflowId = createPrerenderWorkflowId(task);
    try {
      await this.env.PRERENDER_WORKFLOW.create({
        id: workflowId,
        params: task,
      });
    } catch (error) {
      if (
        !isWorkflowAlreadyExistsError(error) &&
        !(await workflowInstanceExists(this.env.PRERENDER_WORKFLOW, workflowId))
      ) {
        throw error;
      }
    }
    return { status: "accepted", workflowId };
  }

  async inspect(input: unknown): Promise<{
    status: "complete" | "missing" | "invalid";
  }> {
    const identity = validateIdentityForRelease(
      readIdentity(input),
      this.env.DOXA_RENDERER_RELEASE_ID,
    );
    return inspectPrerenderManifest({
      bucket: createBucketAdapter(this.env.DOCS_RENDERED_BUCKET),
      identity,
    });
  }

  /**
   * Deletes the stored objects of one render for the API garbage collector.
   * The render identity is validated here and the object keys are built here.
   * A caller never supplies an object key or a prefix.
   */
  async collectRender(input: unknown): Promise<StorageGcCollection> {
    const request = collectRenderRequestSchema.parse(input);
    const resource = docsPrerenderRenderResourceSchema.parse({
      siteId: request.siteId,
      renderId: request.renderId,
      ...(request.hostname === undefined
        ? {}
        : { hostname: request.hostname }),
    });
    return collectPrerenderRender({
      bucket: createBucketAdapter(this.env.DOCS_RENDERED_BUCKET),
      siteId: resource.siteId,
      renderId: resource.renderId,
      ...(request.limit === undefined ? {} : { limit: request.limit }),
    });
  }
}

const collectRenderRequestSchema = z
  .object({
    siteId: z.string(),
    renderId: z.string(),
    hostname: z.string().optional(),
    limit: z.number().int().min(1).optional(),
  })
  .strict();

function readIdentity(input: unknown): unknown {
  if (typeof input === "object" && input !== null && "identity" in input) {
    return input.identity;
  }
  return undefined;
}

export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  },
};

export function createPrerenderWorkflowId(
  task: Pick<PrerenderTaskPayload, "taskId" | "attempt">,
): string {
  return `docs-prerender-${task.taskId}-attempt-${task.attempt}`;
}

export function isWorkflowAlreadyExistsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /workflow.*(?:already exists|already been created)|instance.*already exists/i.test(
    message,
  );
}

async function workflowInstanceExists(
  workflow: Workflow<PrerenderTaskPayload>,
  workflowId: string,
): Promise<boolean> {
  try {
    const instance = await workflow.get(workflowId);
    const status = await instance.status();
    return status.status !== "unknown";
  } catch {
    return false;
  }
}

export type PrerenderTaskIdentity = PrerenderIdentity;
