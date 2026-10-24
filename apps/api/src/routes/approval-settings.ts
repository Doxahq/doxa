import {
  updateProjectApprovalSettingsInputSchema,
  updateUserApprovalSettingsInputSchema,
} from "@doxahq/contracts/approval-settings";
import { createApiRouter, type ApiApp, type ApiContext } from "../http/app";
import { withUser } from "../http/auth";
import { readValidBody } from "../http/body";
import { projectIdParam } from "../http/path";
import { keepRunning } from "../http/progress-stream";
import { error, json, notFound } from "../http/response";
import { dashboardActor, type DashboardActor } from "../services/agent-access/actor";
import { createAgentActionRuntime } from "../services/agent-actions/action-runtime";
import type { ApprovalSettingsService } from "../services/agent-actions/approval-settings-service";
import { ActionAccessDeniedError, ApprovalSettingInvalidError } from "../services/agent-actions/errors";

export type ApprovalSettingsServiceFactory = (context: ApiContext) => ApprovalSettingsService;

const defaultSettings: ApprovalSettingsServiceFactory = (context) =>
  createAgentActionRuntime(context.env, { defer: (work) => keepRunning(context, work) }).settings;

/** Mounted under `/projects/:projectId/approval-settings` (v2 spec §4). */
export function createProjectApprovalSettingsRoutes(
  settings: ApprovalSettingsServiceFactory = defaultSettings,
): ApiApp {
  const app = createApiRouter();
  app.get("/", (context) =>
    withDashboard(context, async (actor) => json(await settings(context).getProject(actor, projectIdParam(context)))),
  );
  app.put("/", (context) =>
    withDashboard(context, async (actor) => {
      const body = await readValidBody(context.req.raw, updateProjectApprovalSettingsInputSchema);
      if (body === null) return error("Invalid approval settings.", 400);
      return json(await settings(context).updateProject(actor, projectIdParam(context), body));
    }),
  );
  return app;
}

/** Mounted under `/approval-settings`: the user's defaults for every project. */
export function createUserApprovalSettingsRoutes(
  settings: ApprovalSettingsServiceFactory = defaultSettings,
): ApiApp {
  const app = createApiRouter();
  app.get("/", (context) => withDashboard(context, async (actor) => json(await settings(context).getUser(actor))));
  app.put("/", (context) =>
    withDashboard(context, async (actor) => {
      const body = await readValidBody(context.req.raw, updateUserApprovalSettingsInputSchema);
      if (body === null) return error("Invalid approval settings.", 400);
      return json(await settings(context).updateUser(actor, body));
    }),
  );
  return app;
}

function withDashboard(
  context: ApiContext,
  handler: (actor: DashboardActor) => Promise<Response>,
): Promise<Response> {
  return withUser(context, async (userId) => {
    try {
      return await handler(dashboardActor(userId));
    } catch (cause) {
      if (cause instanceof ApprovalSettingInvalidError) return error(cause.message, 400);
      if (cause instanceof ActionAccessDeniedError) {
        // Only a member without the capability learns that the project exists.
        if (cause.reason === "forbidden") {
          return error("You cannot change the approval settings of this project.", 403, { code: "forbidden" });
        }
        return notFound();
      }
      throw cause;
    }
  });
}
