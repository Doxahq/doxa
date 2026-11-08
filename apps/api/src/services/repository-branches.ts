import { z } from "zod";
import type { RepositoryBranchesDto } from "@doxahq/contracts";
import type { Env } from "../env";
import { GITHUB_API_BASE_URL, githubApiHeaders } from "./doxabot/github-api";
import {
  InstallationTokenRequestError,
  createInstallationAccessToken,
  isLocalInstallation,
} from "./github-app";
import { repositoryReadScope } from "./repository-read-access";
import type { RepositoryBranchTarget } from "../repositories/github";

export type { RepositoryBranchTarget };

interface RepositoryBranchesDependencies {
  /** A token that can read only `target`'s repository. */
  createReadToken(target: RepositoryBranchTarget): Promise<string>;
  fetch: typeof fetch;
}

/** GitHub could not answer. The caller shows "try again", not "no such branch". */
export class RepositoryBranchesUnavailableError extends Error {
  constructor(readonly status: number | null) {
    super(`GitHub branch request failed${status === null ? "" : ` (${status})`}.`);
    this.name = "RepositoryBranchesUnavailableError";
  }
}

const GITHUB_PAGE_SIZE = 100;
/** 1,000 branches. A repository with more lists the first ones and accepts a typed name. */
const MAX_BRANCH_PAGES = 10;

const branchListSchema = z.array(z.object({ name: z.string().min(1) }).passthrough());
const branchSchema = z.object({ name: z.string().min(1) }).passthrough();

/** The branches of a connected repository, read with a token scoped to it. */
export class RepositoryBranchesService {
  private readonly fetchRequest: typeof fetch;

  constructor(private readonly dependencies: RepositoryBranchesDependencies) {
    this.fetchRequest = dependencies.fetch.bind(globalThis);
  }

  static fromEnv(env: Env): RepositoryBranchesService {
    return new RepositoryBranchesService({
      createReadToken: async (target) => {
        const token = await createInstallationAccessToken(
          env,
          target.installationId,
          repositoryReadScope(target.externalId),
        );
        return token.token;
      },
      fetch,
    });
  }

  /** The default branch first, then the others in GitHub's order. */
  async list(target: RepositoryBranchTarget): Promise<RepositoryBranchesDto> {
    // A local installation has no GitHub repository to ask.
    if (isLocalInstallation(target.installationId)) {
      return { defaultBranch: target.defaultBranch, branches: [target.defaultBranch], complete: false };
    }

    const token = await this.readToken(target);
    const names: string[] = [];
    for (let page = 1; page <= MAX_BRANCH_PAGES; page += 1) {
      const response = await this.fetchRequest(
        `${repositoryUrl(target)}/branches?per_page=${GITHUB_PAGE_SIZE}&page=${page}`,
        { method: "GET", headers: githubApiHeaders(token) },
      );
      if (!response.ok) throw new RepositoryBranchesUnavailableError(response.status);

      const parsed = branchListSchema.safeParse(await response.json());
      if (!parsed.success) throw new RepositoryBranchesUnavailableError(null);
      names.push(...parsed.data.map((branch) => branch.name));
      if (parsed.data.length < GITHUB_PAGE_SIZE) {
        return toBranchList(target.defaultBranch, names, true);
      }
    }
    return toBranchList(target.defaultBranch, names, false);
  }

  /** Whether the branch exists now. A renamed branch does not count as its old name. */
  async exists(target: RepositoryBranchTarget, branch: string): Promise<boolean> {
    if (isLocalInstallation(target.installationId)) return true;

    const token = await this.readToken(target);
    const response = await this.fetchRequest(
      `${repositoryUrl(target)}/branches/${branchPath(branch)}`,
      { method: "GET", headers: githubApiHeaders(token) },
    );
    if (response.status === 404) return false;
    if (!response.ok) throw new RepositoryBranchesUnavailableError(response.status);

    const parsed = branchSchema.safeParse(await response.json());
    if (!parsed.success) throw new RepositoryBranchesUnavailableError(null);
    // GitHub answers an old name of a renamed branch with the new branch.
    return parsed.data.name === branch;
  }

  /** A refused token is a GitHub answer like any other failed request. */
  private async readToken(target: RepositoryBranchTarget): Promise<string> {
    try {
      return await this.dependencies.createReadToken(target);
    } catch (caught) {
      if (caught instanceof InstallationTokenRequestError) {
        throw new RepositoryBranchesUnavailableError(caught.status);
      }
      throw caught;
    }
  }
}

function repositoryUrl(target: RepositoryBranchTarget): string {
  return `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}`;
}

/** `release/2.x` stays a path, and each part is escaped. */
function branchPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function toBranchList(defaultBranch: string, names: readonly string[], complete: boolean): RepositoryBranchesDto {
  const others = names.filter((name) => name !== defaultBranch);
  // The default branch leads even when the list stopped before it.
  return { defaultBranch, branches: [defaultBranch, ...others], complete };
}
