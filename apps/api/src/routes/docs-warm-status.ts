import type { DocsWarmStatusResponse } from "@doxahq/contracts/docs-warm-job";
import { createApiRouter, type ApiApp } from "../http/app";
import { readClientWarmPool } from "../http/client-region";
import { withProjectAccess } from "../http/project-access";
import { json } from "../http/response";
import { DocsWarmStatusService } from "../services/docs-warm-status";

/**
 * The regional warm progress after a publish (M45b). Anyone who may read the
 * project's docs may read it; an unknown status is `null`, never an error.
 */
export function createDocsWarmStatusRoutes(): ApiApp {
  const app = createApiRouter();
  app.get("/", (context) =>
    withProjectAccess(context, "docs.read", async (access) => {
      const body: DocsWarmStatusResponse = {
        status: await DocsWarmStatusService.fromEnv(context.env).forProject(access.projectId),
        clientRegion: readClientWarmPool(context.req.raw),
      };
      return json(body);
    }),
  );
  return app;
}
