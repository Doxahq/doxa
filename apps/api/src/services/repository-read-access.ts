import type { Env } from "../env";
import {
  GitHubRepository,
  type ProductionGenerationSourceContext,
} from "../repositories/github";
import { parseGitHubRepositoryId } from "./doxabot/github-api";
import {
  createInstallationAccessToken,
  isLocalInstallation,
  type InstallationAccessTokenScope,
} from "./github-app";

/** The repository a project generates from, with what a read token needs. */
export type RepositoryReadTarget = ProductionGenerationSourceContext;

export interface RepositoryReadAccess {
  target: RepositoryReadTarget;
  token: string;
}

/** Read access to one repository: its files and metadata, nothing else. */
export function repositoryReadScope(externalId: string): InstallationAccessTokenScope {
  return {
    repositoryIds: [parseGitHubRepositoryId(externalId)],
    permissions: { contents: "read", metadata: "read" },
  };
}

/**
 * A token that can only read the project's repository. The API resolves the
 * installation and the repository from the project, so a caller cannot ask
 * for access to another repository.
 */
export async function createRepositoryReadAccess(
  env: Env,
  projectId: string,
): Promise<RepositoryReadAccess> {
  const target = await new GitHubRepository(env).getProductionSource(projectId);
  if (!target) throw new Error("The project has no connected repository.");

  // A local installation uses one developer token, which cannot be scoped.
  const scope = isLocalInstallation(target.installationId)
    ? undefined
    : repositoryReadScope(target.externalId);
  const { token } = await createInstallationAccessToken(env, target.installationId, scope);
  return { target, token };
}
