import { z } from "zod";
import type { Env } from "../env";
import {
  GitHubRepository,
  type ProductionGenerationSourceContext,
} from "../repositories/github";
import {
  createInstallationAccessToken,
  type InstallationAccessTokenScope,
} from "./github-app";
import {
  GITHUB_API_BASE_URL,
  githubApiHeaders,
  parseGitHubRepositoryId,
} from "./doxabot/github-api";
import type {
  ProductionGenerationSource,
  ProductionGenerationTarget,
} from "./production-generation-admission";

interface ProductionGenerationSourceRepository {
  getProductionSource(
    projectId: string,
  ): Promise<ProductionGenerationSourceContext | null>;
}

interface GitHubProductionGenerationSourceDependencies {
  repositories: ProductionGenerationSourceRepository;
  createInstallationToken(input: {
    installationId: string;
    scope: InstallationAccessTokenScope;
  }): Promise<string>;
  fetch: typeof fetch;
}

const commitResponseSchema = z.object({
  sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  commit: z.object({
    tree: z.object({
      sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    }),
  }),
}).passthrough();

export class GitHubProductionGenerationSource
  implements ProductionGenerationSource
{
  private readonly fetchRequest: typeof fetch;

  constructor(
    private readonly dependencies:
      GitHubProductionGenerationSourceDependencies,
  ) {
    this.fetchRequest = dependencies.fetch.bind(globalThis);
  }

  static fromEnv(env: Env): GitHubProductionGenerationSource {
    return new GitHubProductionGenerationSource({
      repositories: new GitHubRepository(env),
      createInstallationToken: async (input) => {
        const token = await createInstallationAccessToken(
          env,
          input.installationId,
          input.scope,
        );
        return token.token;
      },
      fetch,
    });
  }

  async resolveTarget(
    projectId: string,
  ): Promise<ProductionGenerationTarget> {
    const repository =
      await this.dependencies.repositories.getProductionSource(
        projectId,
      );
    if (!repository) {
      throw new Error(
        "Production generation source repository was not found.",
      );
    }

    const repositoryId = parseGitHubRepositoryId(
      repository.externalId,
    );
    const token =
      await this.dependencies.createInstallationToken({
        installationId: repository.installationId,
        scope: {
          repositoryIds: [repositoryId],
          permissions: {
            contents: "read",
            metadata: "read",
          },
        },
      });
    const owner = encodeURIComponent(repository.owner);
    const name = encodeURIComponent(repository.name);
    const branch = encodeURIComponent(repository.defaultBranch);
    const response = await this.fetchRequest(
      `${GITHUB_API_BASE_URL}/repos/${owner}/${name}/commits/${branch}`,
      {
        method: "GET",
        headers: githubApiHeaders(token),
      },
    );
    if (!response.ok) {
      throw new Error(
        `GitHub default branch lookup failed (${response.status}).`,
      );
    }

    const parsed = commitResponseSchema.safeParse(
      await response.json(),
    );
    if (!parsed.success) {
      throw new Error(
        "GitHub default branch response was invalid.",
      );
    }
    return {
      revision: parsed.data.sha,
      treeHash: parsed.data.commit.tree.sha,
    };
  }
}
