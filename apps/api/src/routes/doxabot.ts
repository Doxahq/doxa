import { updateDoxabotSettingsInputSchema } from "@doxahq/contracts";
import { createApiRouter, type ApiApp, type ApiContext } from "../http/app";
import {
  withProjectAccess,
  type DashboardProjectAccess,
} from "../http/project-access";
import { error, json } from "../http/response";
import { parseValidatedJson } from "../http/validation";
import { PendingMergesRepository } from "../repositories/pending-merges";
import { createDoxabotInstructionsRoutes } from "./doxabot-instructions";
import {
  DoxabotSettingsError,
  DoxabotSettingsService,
} from "../services/doxabot/settings";

export function createDoxabotRoutes(): ApiApp {
  const app = createApiRouter();

  app.route("/instructions", createDoxabotInstructionsRoutes());

  app.get("/", (context) =>
    withProjectAccess(context, "project.read", (access) =>
      readDoxabotSettings(context, access),
    ),
  );

  app.get("/pending-merges", (context) =>
    withProjectAccess(context, "project.read", (access) =>
      listPendingMerges(context, access),
    ),
  );

  // Doxabot starts generations on repository changes, so it needs the
  // capability to run them.
  app.put("/", (context) =>
    withProjectAccess(context, "generation.run", async (access) => {
      const input = await parseValidatedJson(
        context,
        updateDoxabotSettingsInputSchema,
        "Invalid Doxabot settings payload.",
      );
      if (!input.ok) return input.response;

      try {
        const settings = await DoxabotSettingsService.fromEnv(
          context.env,
        ).updateForOwner({
          projectId: access.projectId,
          userId: access.ownerUserId,
          updatedByUserId: access.actorUserId,
          changes: input.data,
        });
        return json({ settings });
      } catch (caught) {
        return mapDoxabotSettingsError(caught);
      }
    }),
  );

  return app;
}

function mapDoxabotSettingsError(caught: unknown): Response {
  if (!(caught instanceof DoxabotSettingsError)) throw caught;

  switch (caught.code) {
    case "project_not_found":
      return error(caught.message, 404, { code: caught.code });
    case "forbidden":
      return error(caught.message, 403, { code: caught.code });
    case "enablement_unavailable":
      return error(caught.message, 409, {
        code: caught.unavailableReason,
      });
  }
}

/** `GET /projects/:projectId/doxabot`, after `project.read` passed. */
export async function readDoxabotSettings(
  context: ApiContext,
  access: DashboardProjectAccess,
): Promise<Response> {
  try {
    const settings = await DoxabotSettingsService.fromEnv(
      context.env,
    ).getForOwner({ projectId: access.projectId, userId: access.ownerUserId });
    return json({ settings });
  } catch (caught) {
    return mapDoxabotSettingsError(caught);
  }
}

/** `GET /projects/:projectId/doxabot/pending-merges`, after `project.read` passed. */
export async function listPendingMerges(
  context: ApiContext,
  access: DashboardProjectAccess,
): Promise<Response> {
  const merges = await new PendingMergesRepository(
    context.env,
  ).listForProject(access.projectId);
  return json({ merges });
}
