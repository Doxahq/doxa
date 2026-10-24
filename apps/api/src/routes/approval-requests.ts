import {
  approvalRequestListQuerySchema,
  approveApprovalRequestInputSchema,
  rejectApprovalRequestInputSchema,
  type ApprovalRequestStatus,
} from "@doxahq/contracts/approval-requests";
import type { DocsPublishStage } from "@doxahq/contracts/docs-branches";
import { createApiRouter, type ApiApp, type ApiContext } from "../http/app";
import { withUser } from "../http/auth";
import { readValidBody } from "../http/body";
import { toSafeErrorLog } from "../http/error-log";
import { acceptsEventStream, keepRunning, streamProgress } from "../http/progress-stream";
import { projectIdParam } from "../http/path";
import { error, json, notFound } from "../http/response";
import { dashboardActor, type DashboardActor } from "../services/agent-access/actor";
import { createAgentActionRuntime } from "../services/agent-actions/action-runtime";
import type { ApprovalService } from "../services/agent-actions/approval-service";
import {
  ActionAccessDeniedError,
  ActionUnavailableError,
  ApprovalRequestNotFoundError,
  ConfirmationMismatchError,
  OtherDeciderRequiredError,
  RequestNotPendingError,
} from "../services/agent-actions/errors";

export type ApprovalServiceFactory = (context: ApiContext) => ApprovalService;

const defaultApprovals: ApprovalServiceFactory = (context) =>
  createAgentActionRuntime(context.env, { defer: (work) => keepRunning(context, work) }).approvals;

/** `GET /approval-requests/:id`: the lookup behind the web link `/approve/<id>`. */
export function createApprovalRequestLinkRoutes(
  approvals: ApprovalServiceFactory = defaultApprovals,
): ApiApp {
  const app = createApiRouter();
  app.get("/:requestId", (context) =>
    withDashboard(context, async (actor) =>
      json(await approvals(context).link(actor, context.req.param("requestId"))),
    ),
  );
  return app;
}

/** Mounted under `/projects/:projectId/approval-requests` (spec 8.7). */
export function createProjectApprovalRequestRoutes(
  approvals: ApprovalServiceFactory = defaultApprovals,
): ApiApp {
  const app = createApiRouter();
  app.get("/", (context) =>
    withUser(context, async (userId) => {
      const query = approvalRequestListQuerySchema.safeParse(context.req.query());
      if (!query.success) return error("Invalid approval request query.", 400);
      return listProjectApprovalRequests(context, userId, query.data.status, approvals);
    }),
  );
  app.get("/:requestId", (context) =>
    withDashboard(context, async (actor) => {
      const detail = await approvals(context).review(actor, context.req.param("requestId"));
      return detail.projectId === projectIdParam(context) ? json(detail) : notFound();
    }),
  );
  app.post("/:requestId/approve", (context) =>
    withDashboard(context, async (actor) => {
      const body = await readValidBody(context.req.raw, approveApprovalRequestInputSchema, { optional: true });
      if (body === null) return error("Invalid approve request.", 400);
      const service = approvals(context);
      const requestId = await ownedRequestId(service, actor, context);
      const approve = (onProgress?: (stage: DocsPublishStage) => void) =>
        service.approve(actor, requestId, {
          confirmation: body.confirmation,
          eraseBranch: body.eraseBranch,
          onProgress,
        });
      if (!acceptsEventStream(context.req.raw)) return json(await approve());
      return streamProgress(context, approve, approvalErrorResponse);
    }),
  );
  app.post("/:requestId/reject", (context) =>
    withDashboard(context, async (actor) => {
      const body = await readValidBody(context.req.raw, rejectApprovalRequestInputSchema, { optional: true });
      if (body === null) return error("Invalid reject request.", 400);
      const service = approvals(context);
      const requestId = await ownedRequestId(service, actor, context);
      return json(await service.reject(actor, requestId, body.reason));
    }),
  );
  return app;
}

/**
 * `GET /projects/:projectId/approval-requests`, for the signed-in user. The
 * approval service checks the project access itself.
 */
export function listProjectApprovalRequests(
  context: ApiContext,
  userId: string,
  status: ApprovalRequestStatus | undefined,
  approvals: ApprovalServiceFactory = defaultApprovals,
): Promise<Response> {
  return withKnownErrors(async () => {
    const requests = await approvals(context).listForProject(
      dashboardActor(userId),
      projectIdParam(context),
      status,
    );
    return json({ requests });
  });
}

/** A request ID from another project's path reads as "not found". */
async function ownedRequestId(
  service: ApprovalService,
  actor: DashboardActor,
  context: ApiContext,
): Promise<string> {
  const requestId = context.req.param("requestId") ?? "";
  const detail = await service.get(actor, requestId);
  if (detail.projectId !== projectIdParam(context)) throw new ApprovalRequestNotFoundError();
  return requestId;
}

function withDashboard(
  context: ApiContext,
  handler: (actor: DashboardActor) => Promise<Response>,
): Promise<Response> {
  return withUser(context, (userId) =>
    withKnownErrors(() => handler(dashboardActor(userId))),
  );
}

async function withKnownErrors(
  handler: () => Promise<Response>,
): Promise<Response> {
  try {
    return await handler();
  } catch (cause) {
    const response = knownErrorResponse(cause);
    if (response) return response;
    throw cause;
  }
}

function knownErrorResponse(cause: unknown): Response | null {
  if (cause instanceof ApprovalRequestNotFoundError) return notFound();
  if (cause instanceof RequestNotPendingError) {
    return error(cause.message, 409, { code: "request_not_pending", status: cause.status });
  }
  if (cause instanceof ConfirmationMismatchError) {
    return error(cause.message, 422, { code: "confirmation_mismatch" });
  }
  if (cause instanceof ActionUnavailableError) {
    return error(cause.message, 409, { code: "action_removed" });
  }
  if (cause instanceof OtherDeciderRequiredError) {
    return error(cause.message, 403, { code: "other_decider_required" });
  }
  if (cause instanceof ActionAccessDeniedError) {
    return error("You cannot decide this request.", 403, { code: cause.reason });
  }
  return null;
}

function approvalErrorResponse(cause: unknown): Response {
  const response = knownErrorResponse(cause);
  if (response) return response;
  console.error("Unhandled request error.", toSafeErrorLog(cause));
  return error("Internal server error.", 500);
}
