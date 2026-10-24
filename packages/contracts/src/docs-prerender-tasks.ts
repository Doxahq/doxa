import { z } from "zod";

import { docsHostResolutionSchema } from "./index";
import { prerenderIdentitySchema } from "./docs-prerender";
import type {
  DocsPrerenderRenderResource,
  StorageGcCollection,
} from "./storage-gc";

export const DOCS_PRERENDER_MAX_ATTEMPTS = 8;

export const docsPrerenderTaskReasonSchema = z.enum([
  "generation",
  "promotion",
  "restore",
  "editor_publication",
  "starter_publication",
  "hostname_activation",
  "repair",
  "reconciliation",
]);

export const docsPrerenderTaskStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "obsolete",
]);

export const prerenderTaskPayloadSchema = z
  .object({
    taskId: z.string().uuid(),
    claimToken: z.string().min(16).max(200),
    attempt: z.number().int().min(1).max(DOCS_PRERENDER_MAX_ATTEMPTS),
    reason: docsPrerenderTaskReasonSchema,
    resolution: docsHostResolutionSchema,
    identity: prerenderIdentitySchema,
  })
  .strict()
  .superRefine((task, context) => {
    if (
      task.resolution.siteId !== task.identity.siteId ||
      task.resolution.artifactPrefix !== task.identity.artifactPrefix ||
      task.resolution.manifestPath !== task.identity.sourceManifestPath
    ) {
      context.addIssue({
        code: "custom",
        message: "The task resolution does not match its render identity.",
      });
    }
  });

export const prerenderRepairRequestSchema = z
  .object({
    resolution: docsHostResolutionSchema,
    identity: prerenderIdentitySchema,
    pathname: z.string().min(1).max(2_048),
    reason: z.enum(["manifest_missing", "invalid_output"]),
  })
  .strict();

export type DocsPrerenderTaskReason = z.infer<
  typeof docsPrerenderTaskReasonSchema
>;
export type DocsPrerenderTaskStatus = z.infer<
  typeof docsPrerenderTaskStatusSchema
>;
export type PrerenderTaskPayload = z.infer<
  typeof prerenderTaskPayloadSchema
>;
export type PrerenderRepairRequest = z.infer<
  typeof prerenderRepairRequestSchema
>;

export type PrerenderTaskFenceResult =
  | { status: "accepted" }
  | { status: "stale" };
export type PrerenderTaskEligibilityResult =
  | { status: "active" }
  | { status: "obsolete" }
  | { status: "stale" };

export interface PrerenderTaskApiRpc {
  validate(input: {
    taskId: string;
    claimToken: string;
    identity: z.infer<typeof prerenderIdentitySchema>;
  }): Promise<PrerenderTaskEligibilityResult>;
  heartbeat(input: {
    taskId: string;
    claimToken: string;
    completedRoutes: number;
    totalRoutes: number;
  }): Promise<PrerenderTaskFenceResult>;
  complete(input: {
    taskId: string;
    claimToken: string;
    routeCount: number;
    outcome: "committed" | "already_complete";
  }): Promise<PrerenderTaskFenceResult>;
  fail(input: {
    taskId: string;
    claimToken: string;
    errorCode: "prerender_failed" | "unsupported_output";
    errorMessage: string;
    retryable: boolean;
  }): Promise<PrerenderTaskFenceResult>;
  enqueueRepair(input: PrerenderRepairRequest): Promise<{
    status: "accepted" | "cooldown";
    taskId?: string;
  }>;
}

export interface PrerenderQueueRpc {
  start(input: PrerenderTaskPayload): Promise<{
    status: "accepted";
    workflowId: string;
  }>;
  inspect(input: {
    identity: z.infer<typeof prerenderIdentitySchema>;
  }): Promise<{ status: "complete" | "missing" | "invalid" }>;
  /**
   * Deletes every stored object of one render. The caller supplies the site
   * and render identity only. This Worker builds the object keys.
   */
  collectRender(
    input: DocsPrerenderRenderResource & { limit?: number },
  ): Promise<StorageGcCollection>;
}
