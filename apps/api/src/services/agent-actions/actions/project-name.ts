import type { ProjectScopedInput, ProjectsPort } from "../action-ports";
import { ActionExecutionError } from "../errors";

export async function requireProjectName(
  projects: Pick<ProjectsPort, "find">,
  input: ProjectScopedInput,
): Promise<string> {
  const project = await projects.find(input);
  if (project === null) throw new ActionExecutionError("project_not_found", "Project not found.");
  return project.name;
}
