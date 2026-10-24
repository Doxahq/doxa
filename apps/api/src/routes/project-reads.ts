import type { ApiContext } from "../http/app";
import type { DashboardProjectAccess } from "../http/project-access";
import { json, notFound } from "../http/response";
import { JobsRepository } from "../repositories/jobs";
import { ProjectsRepository } from "../repositories/projects";
import type { GenerationPageRequest } from "../utils/generation-pagination";
import { withPreferredDocsUrl } from "../utils/project-docs-urls";

/**
 * Project reads that both their own route and the project shell
 * (`GET /projects/:projectId/shell`) answer. The caller has already checked
 * the access.
 */
/** `GET /projects/:projectId`, after `project.read` passed. */
export async function readProjectDetail(
  context: ApiContext,
  access: DashboardProjectAccess,
): Promise<Response> {
  const project = await new ProjectsRepository(context.env).getForUser(
    access.ownerUserId,
    access.projectId,
  );
  if (!project) return notFound();
  const job = await new JobsRepository(context.env).latestForProject(
    project.id,
  );
  return json({
    project: await withPreferredDocsUrl(project, context.env),
    latestJob: job,
    // The viewer's role, so the dashboard hides what it cannot do.
    role: access.role,
  });
}

/** `GET /projects/:projectId/generations`, after `generation.read` passed. */
export async function listGenerationsPage(
  context: ApiContext,
  access: DashboardProjectAccess,
  pagination: GenerationPageRequest,
): Promise<Response> {
  const { projectId, ownerUserId: userId } = access;
  const project = await new ProjectsRepository(context.env).getForUser(
    userId,
    projectId,
  );
  if (!project) return notFound();

  const page = await new JobsRepository(context.env).listForProject({
    userId,
    projectId: project.id,
    ...pagination,
  });
  return json(page);
}
