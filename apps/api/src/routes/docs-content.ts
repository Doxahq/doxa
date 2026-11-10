import type {
  ApplyDocsContentEditsResult,
  DocsContentEdit,
  DocsContentEditOrigin,
  DocsContentMdxReport,
} from "@doxahq/contracts";
import { createApiRouter } from "../http/app";
import type { ApiApp, ApiContext } from "../http/app";
import {
  forbidden,
  withProjectAccess,
  type DashboardProjectAccess,
} from "../http/project-access";
import { serviceRequestOptions } from "../http/request-state";
import { error, json, validationError } from "../http/response";
import { parseContentEdits } from "../http/content-edits";
import { SiteConfigValidationError } from "../services/site-config-validation";
import { editMdxIssues } from "../services/docs-content/page-mdx-issues";
import {
  DocsContentError,
  DocsContentService,
  getDocsContentErrorStatus,
  type DocsContentActor,
} from "../services/docs-content/service";

/**
 * Docs content editor routes.
 *
 * Each handler authorizes the session user through the project access policy,
 * delegates to `DocsContentService` with the project owner's ID, and maps
 * service errors to status codes. Keep the
 * behavior in the service: other surfaces call it without going through HTTP.
 */
export function createDocsContentRoutes(): ApiApp {
  const app = createApiRouter();

  app.get("/", (context) =>
    withProjectAccess(context, "docs.read", (access) =>
      run(async () => {
        const overview = await contentService(context).getOverview(
          actor(access),
          access.projectId,
          requireBranch(context),
        );
        return json({ content: overview });
      }),
    ),
  );

  app.get("/page", (context) =>
    withProjectAccess(context, "docs.read", (access) =>
      run(async () => {
        const href = new URL(context.req.url).searchParams.get("href");
        if (!href) return error("A page href is required.", 400);

        const page = await contentService(context).getPage(
          actor(access),
          access.projectId,
          href,
          requireBranch(context),
        );
        return json({ page });
      }),
    ),
  );

  app.post("/edits", (context) =>
    withProjectAccess(context, "docs.write", (access) =>
      run(async () => {
        const input = await parseContentEdits(context.req.raw);
        if (!input.ok) return input.response;
        if (
          input.data.edits.some(isSiteConfigEdit) &&
          !access.capabilities.has("site.write")
        ) {
          return forbidden();
        }

        const working = await contentService(context).applyEdits(
          actor(access),
          access.projectId,
          input.data.edits,
          input.data.branch,
          { expectedRevision: input.data.expectedRevision },
        );
        // Spec 8.1: the save stands even when a page fails the MDX check. A
        // person edits in steps, so the issues come back for the editor.
        const result: ApplyDocsContentEditsResult = {
          working,
          mdxIssues: editMdxIssues(input.data.edits),
        };
        return json(result);
      }),
    ),
  );

  app.get("/mdx-issues", (context) =>
    withProjectAccess(context, "docs.read", (access) =>
      run(async () => {
        const report: DocsContentMdxReport = await contentService(
          context,
        ).getMdxReport(actor(access), access.projectId, requireBranch(context));
        return json(report);
      }),
    ),
  );

  return app;
}

function contentService(context: ApiContext): DocsContentService {
  return DocsContentService.fromEnv(
    context.env,
    serviceRequestOptions(context),
  );
}

function requireBranch(context: ApiContext): string {
  const branch = new URL(context.req.url).searchParams.get("branch");
  if (!branch) throw new MissingBranchError();
  return branch;
}

class MissingBranchError extends Error {}

/**
 * Every request on these routes comes from the dashboard editor. The origin is
 * never read from the request: agent origins are set server-side by the MCP
 * Worker.
 */
const DASHBOARD_EDIT_ORIGIN = "editor" satisfies DocsContentEditOrigin;

/** The docs services take the project owner's ID, as for agents (spec 7.4). */
function actor(access: DashboardProjectAccess): DocsContentActor {
  return { userId: access.ownerUserId, origin: DASHBOARD_EDIT_ORIGIN };
}

/** Site settings edits, including the home page, also need `site.write`. */
function isSiteConfigEdit(edit: DocsContentEdit): boolean {
  return (
    edit.type === "set_site_config" ||
    edit.type === "reset_site_config" ||
    edit.type === "set_home_page"
  );
}

async function run(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (err) {
    if (err instanceof MissingBranchError)
      return error("A branch is required.", 400);
    if (err instanceof SiteConfigValidationError)
      return validationError(err.issues);
    if (err instanceof DocsContentError) {
      return error(err.message, getDocsContentErrorStatus(err.code), {
        code: err.code,
        ...(err.details && typeof err.details === "object" ? err.details : {}),
      });
    }
    throw err;
  }
}
