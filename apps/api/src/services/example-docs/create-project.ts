import type { ProjectDto } from "@doxahq/contracts";
import type { Env } from "../../env";
import { ProjectDeletionRepository } from "../../repositories/project-deletion";
import { ProjectsRepository } from "../../repositories/projects";
import { publishExampleDocs } from "./publish";

/**
 * Creates a project with no repository and publishes the example docs as its
 * first version. The editor needs a published version, so a project is
 * removed again when the example cannot be published. The removal queues
 * any example files that were already written for the garbage collector.
 */
export async function createExampleProject(
  env: Env,
  input: { userId: string; name: string; slug?: string },
): Promise<ProjectDto> {
  const projects = new ProjectsRepository(env);
  const { project, siteId } = await projects.createWithoutRepository(input);
  try {
    const version = await publishExampleDocs(env, {
      projectId: project.id,
      siteId,
      slug: project.slug,
      name: project.name,
    });
    return { ...project, publishedVersionId: version.id };
  } catch (err) {
    await new ProjectDeletionRepository(env).deleteForUser({
      userId: input.userId,
      projectId: project.id,
    });
    throw err;
  }
}
