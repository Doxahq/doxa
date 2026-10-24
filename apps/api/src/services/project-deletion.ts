import type { Env } from "../env";
import {
  GENERATION_ACTIVE_DELETE_MESSAGE,
  ProjectDeletionError,
  ProjectDeletionRepository,
  type DeletedProject,
} from "../repositories/project-deletion";
import { ProjectsRepository } from "../repositories/projects";
import { DocsDomainLifecycleService } from "./docs-domain-lifecycle";

/**
 * Deletes a project permanently.
 *
 * 1. Refuse while a generation runs, because its container still writes.
 * 2. Remove the custom hostnames from Cloudflare. A failure stops here, so
 *    the project stays and the user can try again.
 * 3. Delete the rows and queue the storage for the garbage collector.
 */
export async function deleteProject(
  env: Env,
  input: { userId: string; projectId: string },
): Promise<DeletedProject> {
  const project = await new ProjectsRepository(env).getForUser(
    input.userId,
    input.projectId,
  );
  if (!project) {
    throw new ProjectDeletionError("project_not_found", "Project not found.");
  }

  const deletion = new ProjectDeletionRepository(env);
  if (await deletion.hasActiveGeneration(project.id)) {
    throw new ProjectDeletionError(
      "generation_active",
      GENERATION_ACTIVE_DELETE_MESSAGE,
    );
  }

  await new DocsDomainLifecycleService(env).releaseCustomHostnamesForProject(
    input,
  );
  return deletion.deleteForUser(input);
}
