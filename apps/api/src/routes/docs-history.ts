import {
  docsPublicationListQuerySchema,
  restoreDocsPublicationInputSchema,
} from "@doxahq/contracts/docs-branches";
import { z } from "zod";
import { createApiRouter, type ApiApp } from "../http/app";
import { withProjectAccess } from "../http/project-access";
import { isResponse, parseJson } from "../http/body";
import { readClientWarmPool } from "../http/client-region";
import { error, json, notFound } from "../http/response";
import { DocsBranchHistory } from "../services/docs-branches/history";
import {
  DocsContentError,
  getDocsContentErrorStatus,
} from "../services/docs-content/errors";

export function createDocsHistoryRoutes(): ApiApp {
  const app = createApiRouter();
  app.get("/", (context) =>
    withProjectAccess(context, "docs.read", (access) =>
      run(async () => {
        const url = new URL(context.req.url);
        const parsed = docsPublicationListQuerySchema.safeParse({
          ...(url.searchParams.has("cursor")
            ? { cursor: url.searchParams.get("cursor") }
            : {}),
          ...(url.searchParams.has("limit")
            ? { limit: url.searchParams.get("limit") }
            : {}),
        });

        if (!parsed.success) {
          return error("Invalid history query.", 400);
        }

        const page = await DocsBranchHistory.fromEnv(context.env).list({
          userId: access.ownerUserId,
          projectId: access.projectId,
          ...parsed.data,
        });

        return json(page);
      }),
    ),
  );
  app.post("/:publicationId/restore", (context) =>
    withProjectAccess(context, "docs.restore", (access) =>
      run(async () => {
        const publicationId = context.req.param("publicationId");

        if (!z.uuid().safeParse(publicationId).success) {
          return notFound();
        }

        const body = await parseJson<unknown>(context.req.raw);

        if (isResponse(body)) {
          return body;
        }

        const parsed = restoreDocsPublicationInputSchema.safeParse(body);

        if (!parsed.success) {
          return error("Invalid restore request.", 400);
        }

        const warmRegion = readClientWarmPool(context.req.raw);
        const result = await DocsBranchHistory.fromEnv(context.env).restore({
          userId: access.ownerUserId,
          projectId: access.projectId,
          publicationId,
          expectedMainVersionId: parsed.data.expectedMainVersionId,
          ...(warmRegion ? { warmRegion } : {}),
        });

        return json(result);
      }),
    ),
  );
  return app;
}

async function run(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (cause) {
    if (cause instanceof DocsContentError) {
      return error(cause.message, getDocsContentErrorStatus(cause.code), {
        code: cause.code,
      });
    }

    throw cause;
  }
}
