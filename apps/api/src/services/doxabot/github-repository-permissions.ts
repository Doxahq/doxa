import { z } from "zod";
import type { Env } from "../../env";
import {
  createInstallationAccessToken,
  type InstallationAccessTokenScope,
} from "../github-app";
import {
  GITHUB_API_BASE_URL,
  githubApiHeaders,
  parseGitHubRepositoryId,
} from "./github-api";

export interface RepositoryWriteAccessLookup {
  repositoryOwner: string;
  repositoryName: string;
  repositoryExternalId: string;
  installationExternalId: string;
  /** The provider login of the person. */
  login: string;
}

/** Whether a person may change a repository: push to it, and so start its previews. */
export interface RepositoryWriteAccess {
  canWrite(input: RepositoryWriteAccessLookup): Promise<boolean>;
}

interface GitHubRepositoryPermissionsDependencies {
  createInstallationToken(input: {
    installationId: string;
    scope: InstallationAccessTokenScope;
  }): Promise<string>;
  fetch: typeof fetch;
}

/**
 * GitHub's legacy base role: `maintain` reads as `write`, `triage` as
 * `read`. Only `admin` and `write` can push.
 */
const collaboratorPermissionSchema = z.object({
  permission: z.enum(["admin", "write", "read", "none"]),
});

const WRITE_PERMISSIONS: ReadonlySet<string> = new Set(["admin", "write"]);

export class GitHubRepositoryPermissions implements RepositoryWriteAccess {
  private readonly fetchRequest: typeof fetch;

  constructor(private readonly dependencies: GitHubRepositoryPermissionsDependencies) {
    this.fetchRequest = dependencies.fetch.bind(globalThis);
  }

  static fromEnv(env: Env): GitHubRepositoryPermissions {
    return new GitHubRepositoryPermissions({
      createInstallationToken: async (input) =>
        (await createInstallationAccessToken(env, input.installationId, input.scope)).token,
      fetch,
    });
  }

  /**
   * True when the person has write access. A person who is not a collaborator
   * gets 404 from GitHub, which is false. Any other failure throws, so the
   * caller can tell "no" from "unknown".
   */
  async canWrite(input: RepositoryWriteAccessLookup): Promise<boolean> {
    const token = await this.dependencies.createInstallationToken({
      installationId: input.installationExternalId,
      scope: {
        repositoryIds: [parseGitHubRepositoryId(input.repositoryExternalId)],
        permissions: { metadata: "read" },
      },
    });
    const owner = encodeURIComponent(input.repositoryOwner);
    const repository = encodeURIComponent(input.repositoryName);
    const login = encodeURIComponent(input.login);
    const response = await this.fetchRequest(
      `${GITHUB_API_BASE_URL}/repos/${owner}/${repository}/collaborators/${login}/permission`,
      { method: "GET", headers: githubApiHeaders(token) },
    );
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new Error(`GitHub collaborator permission lookup failed (${response.status}).`);
    }

    const parsed = collaboratorPermissionSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error("GitHub collaborator permission response was not understood.");
    }
    return WRITE_PERMISSIONS.has(parsed.data.permission);
  }
}
