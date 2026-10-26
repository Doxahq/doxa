import {
  restoreDoxabotInstructionsInputSchema,
  saveDoxabotInstructionsInputSchema,
} from "@doxahq/contracts";
import { createApiRouter, type ApiApp, type ApiContext } from "../http/app";
import { withProjectAccess } from "../http/project-access";
import { error, json } from "../http/response";
import { parseValidatedJson } from "../http/validation";
import {
  DoxabotInstructionsError,
  DoxabotInstructionsService,
} from "../services/doxabot/instructions";

export type DoxabotInstructionsServiceFactory = (context: ApiContext) => DoxabotInstructionsService;

const defaultService: DoxabotInstructionsServiceFactory = (context) =>
  DoxabotInstructionsService.fromEnv(context.env);

/**
 * Mounted under `/projects/:projectId/doxabot/instructions`. Every member can
 * read the instructions. Only owners and admins change them, because the
 * instructions steer every generation.
 */
export function createDoxabotInstructionsRoutes(
  service: DoxabotInstructionsServiceFactory = defaultService,
): ApiApp {
  const app = createApiRouter();

  app.get("/", (context) =>
    withProjectAccess(context, "project.read", async (access) =>
      json(await service(context).getState(access.projectId)),
    ),
  );

  app.put("/", (context) =>
    withProjectAccess(context, "instructions.configure", async (access) => {
      const input = await parseValidatedJson(
        context,
        saveDoxabotInstructionsInputSchema,
        "Invalid Doxabot instructions.",
      );
      if (!input.ok) return input.response;

      return respond(() =>
        service(context).save({
          projectId: access.projectId,
          actorUserId: access.actorUserId,
          instructions: input.data.instructions,
          baseVersion: input.data.baseVersion,
        }),
      );
    }),
  );

  app.post("/restore", (context) =>
    withProjectAccess(context, "instructions.configure", async (access) => {
      const input = await parseValidatedJson(
        context,
        restoreDoxabotInstructionsInputSchema,
        "Invalid instructions restore request.",
      );
      if (!input.ok) return input.response;

      return respond(() =>
        service(context).restore({
          projectId: access.projectId,
          actorUserId: access.actorUserId,
          version: input.data.version,
          baseVersion: input.data.baseVersion,
        }),
      );
    }),
  );

  return app;
}

async function respond(write: () => Promise<unknown>): Promise<Response> {
  try {
    return json(await write());
  } catch (caught) {
    if (!(caught instanceof DoxabotInstructionsError)) throw caught;
    switch (caught.code) {
      case "stale_version":
        return error(caught.message, 409, { code: caught.code });
      case "version_not_found":
        return error(caught.message, 404, { code: caught.code });
    }
  }
}
