import { generationReviewPageSourcesQuerySchema } from "@doxahq/contracts/generation-reviews";
import { createApiRouter, type ApiApp } from "../http/app";
import { withProjectAccess } from "../http/project-access";
import { error, json } from "../http/response";
import { GenerationChangesService } from "../services/generation-reviews/generation-changes";
import { projectScope, withDocsContentErrors } from "./generation-reviews";

/**
 * The read-only changes of a pull request preview run, under
 * `/projects/:projectId/generations`. Reading them needs only the right to
 * read generations, as nobody decides on them.
 */
export function createGenerationChangesRoutes(): ApiApp {
  const app = createApiRouter();

  app.get("/:generationId/changes", (context) =>
    withProjectAccess(context, "generation.read", (access) =>
      withDocsContentErrors(async () => {
        const changes = await GenerationChangesService.fromEnv(context.env).list(
          projectScope(access),
          context.req.param("generationId"),
        );
        return json({ changes });
      }),
    ),
  );

  app.get("/:generationId/changes/page", (context) =>
    withProjectAccess(context, "generation.read", (access) =>
      withDocsContentErrors(async () => {
        const query = generationReviewPageSourcesQuerySchema.safeParse({
          href: context.req.query("href"),
        });
        if (!query.success) return error("Invalid changed page request.", 400);

        const sources = await GenerationChangesService.fromEnv(context.env).pageSources(
          projectScope(access),
          context.req.param("generationId"),
          query.data.href,
        );
        return json(sources);
      }),
    ),
  );

  return app;
}
