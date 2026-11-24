import type { ProjectDto } from "@doxahq/contracts";
import type { ProjectTeam } from "@doxahq/contracts/teams";
import type { Env } from "../env";
import { GitHubRepository } from "../repositories/github";
import { CreateProjectError, ProjectsRepository } from "../repositories/projects";
import { assertProjectLimit } from "./project-limit";
import {
  RepositoryBranchesService,
  RepositoryBranchesUnavailableError,
} from "./repository-branches";

/**
 * Refuses a production branch that the repository does not have, before a
 * project stores it. No branch means the repository's default branch, which
 * needs no check. A repository that the user cannot use passes here: the
 * project write then refuses it with its own error.
 */
export async function assertProductionBranchExists(
  env: Env,
  input: { userId: string; githubRepositoryId: string; productionBranch?: string },
): Promise<void> {
  if (input.productionBranch === undefined) return;

  const target = await new GitHubRepository(env).getBranchTargetForUser(
    input.userId,
    input.githubRepositoryId,
  );
  if (!target || target.defaultBranch === input.productionBranch) return;

  let exists: boolean;
  try {
    exists = await RepositoryBranchesService.fromEnv(env).exists(target, input.productionBranch);
  } catch (caught) {
    if (!(caught instanceof RepositoryBranchesUnavailableError)) throw caught;
    throw new CreateProjectError(
      "branch_check_unavailable",
      "GitHub could not confirm the production branch. Try again.",
    );
  }
  if (!exists) {
    throw new CreateProjectError(
      "branch_not_found",
      `The branch "${input.productionBranch}" does not exist in ${target.owner}/${target.name}.`,
    );
  }
}

/** A project for a repository, from the dashboard or an agent. */
export async function createRepositoryProject(
  env: Env,
  input: {
    userId: string;
    githubRepositoryId: string;
    name?: string;
    slug?: string;
    productionBranch?: string;
    /** Authorized by the caller; null makes a personal project. */
    team: ProjectTeam | null;
  },
): Promise<ProjectDto> {
  await assertProjectLimit(env, input);
  await assertProductionBranchExists(env, input);
  return new ProjectsRepository(env).createForRepository(input);
}

/** Links a repository to a project that has none. */
export async function connectProjectRepository(
  env: Env,
  input: {
    userId: string;
    projectId: string;
    githubRepositoryId: string;
    productionBranch?: string;
  },
): Promise<ProjectDto> {
  await assertProductionBranchExists(env, input);
  return new ProjectsRepository(env).connectRepository(input);
}
