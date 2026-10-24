import {
  decideGenerationReviewPagesInputSchema,
  generationReviewPageSourcesQuerySchema,
  publishGenerationReviewInputSchema,
} from "@doxahq/contracts/generation-reviews";
import { createApiRouter, type ApiApp, type ApiContext } from "../http/app";
import type { DashboardProjectAccess } from "../http/project-access";
import { withProjectAccess } from "../http/project-access";
import { error, json } from "../http/response";
import { parseValidatedJson } from "../http/validation";
import {
  DocsContentError,
  getDocsContentErrorStatus,
} from "../services/docs-content/errors";
import { GenerationReviewService } from "../services/generation-reviews/review-service";

/**
 * The open generation review of a project. Each handler authorizes the
 * session user, acts on the owner's review branch, and records the member
 * who made each decision.
 */
export function createGenerationReviewRoutes(): ApiApp {
  const app = createApiRouter();

  app.get("/", (context) =>
    withProjectAccess(context, "docs.read", (access) =>
      readGenerationReview(context, access),
    ),
  );

  app.get("/page", (context) =>
    withProjectAccess(context, "docs.read", (access) =>
      withDocsContentErrors(async () => {
        const query = generationReviewPageSourcesQuerySchema.safeParse({
          href: context.req.query("href"),
        });
        if (!query.success) return error("Invalid review page request.", 400);

        const sources = await GenerationReviewService.fromEnv(
          context.env,
        ).pageSources(projectScope(access), query.data.href);
        return json(sources);
      }),
    ),
  );

  app.post("/decisions", (context) =>
    withProjectAccess(context, "docs.write", (access) =>
      withDocsContentErrors(async () => {
        const input = await parseValidatedJson(
          context,
          decideGenerationReviewPagesInputSchema,
          "Invalid review decision request.",
        );
        if (!input.ok) return input.response;

        const review = await GenerationReviewService.fromEnv(
          context.env,
        ).decide(actorScope(access), input.data);
        return json({ review });
      }),
    ),
  );

  app.post("/publish", (context) =>
    withProjectAccess(context, "docs.publish", (access) =>
      withDocsContentErrors(async () => {
        const input = await parseValidatedJson(
          context,
          publishGenerationReviewInputSchema,
          "Invalid review publish request.",
        );
        if (!input.ok) return input.response;

        const result = await GenerationReviewService.fromEnv(
          context.env,
        ).publish(actorScope(access), input.data);
        return json(result);
      }),
    ),
  );

  app.post("/discard", (context) =>
    withProjectAccess(context, "docs.write", (access) =>
      withDocsContentErrors(async () => {
        await GenerationReviewService.fromEnv(context.env).discard(
          actorScope(access),
        );
        return json({ discarded: true });
      }),
    ),
  );

  return app;
}

export function projectScope(access: DashboardProjectAccess) {
  return { projectId: access.projectId, ownerUserId: access.ownerUserId };
}

function actorScope(access: DashboardProjectAccess) {
  return { ...projectScope(access), actorUserId: access.actorUserId };
}

/** Runs a handler and answers a docs content error with its status and code. */
export async function withDocsContentErrors(
  handler: () => Promise<Response>,
): Promise<Response> {
  try {
    return await handler();
  } catch (cause) {
    if (!(cause instanceof DocsContentError)) {
      throw cause;
    }

    return error(cause.message, getDocsContentErrorStatus(cause.code), {
      code: cause.code,
      ...(cause.details && typeof cause.details === "object"
        ? cause.details
        : {}),
    });
  }
}

/** `GET /projects/:projectId/generation-review`, after `docs.read` passed. */
export function readGenerationReview(
  context: ApiContext,
  access: DashboardProjectAccess,
): Promise<Response> {
  return withDocsContentErrors(async () => {
    const review = await GenerationReviewService.fromEnv(context.env).get(
      projectScope(access),
    );
    return json({ review });
  });
}
