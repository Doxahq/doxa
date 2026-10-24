import { z } from "zod";
import type { Env } from "../../env";
import {
  createInstallationAccessToken,
  type InstallationAccessTokenScope,
} from "../github-app";
import type {
  ChangeProposalSnapshot,
  ChangeProposalStateResolver,
} from "./change-proposal-state";
import {
  GITHUB_API_BASE_URL,
  githubApiHeaders,
  parseGitHubRepositoryId,
} from "./github-api";

interface GitHubPullRequestDependencies {
  createInstallationToken(input: {
    installationId: string;
    scope: InstallationAccessTokenScope;
  }): Promise<string>;
  fetch: typeof fetch;
}

export interface GitHubPullRequestLookup {
  externalId: string;
  number: number;
  repositoryOwner: string;
  repositoryName: string;
  repositoryExternalId: string;
  installationExternalId: string;
}

const gitObjectIdSchema = z.string().regex(
  /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/,
);

const githubPullRequestSchema = z.object({
  id: z.union([
    z.number().int().positive().safe(),
    z.string().regex(/^[1-9]\d*$/),
  ]),
  number: z.number().int().positive(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged: z.boolean(),
  updated_at: z.string().datetime(),
  base: z.object({
    ref: z.string().min(1),
    sha: gitObjectIdSchema,
  }),
  head: z.object({
    sha: gitObjectIdSchema,
  }),
});

export class GitHubPullRequestStateResolver
  implements ChangeProposalStateResolver
{
  private readonly fetchRequest: typeof fetch;

  constructor(
    private readonly dependencies: GitHubPullRequestDependencies,
  ) {
    this.fetchRequest = dependencies.fetch.bind(globalThis);
  }

  static fromEnv(env: Env): GitHubPullRequestStateResolver {
    return new GitHubPullRequestStateResolver({
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

  async getCurrent(
    input: Parameters<ChangeProposalStateResolver["getCurrent"]>[0],
  ): Promise<ChangeProposalSnapshot> {
    return this.getCurrentForJob({
      externalId: input.event.change.externalId,
      number: input.event.change.number,
      repositoryOwner: input.context.repositoryOwner,
      repositoryName: input.context.repositoryName,
      repositoryExternalId: input.context.repositoryExternalId,
      installationExternalId: input.context.installationExternalId,
    });
  }

  async getCurrentForJob(
    input: GitHubPullRequestLookup,
  ): Promise<ChangeProposalSnapshot> {
    const repositoryId = parseGitHubRepositoryId(
      input.repositoryExternalId,
    );
    const token = await this.dependencies.createInstallationToken({
      installationId: input.installationExternalId,
      scope: {
        repositoryIds: [repositoryId],
        permissions: {
          metadata: "read",
          pull_requests: "read",
        },
      },
    });
    const owner = encodeURIComponent(input.repositoryOwner);
    const repository = encodeURIComponent(input.repositoryName);
    const response = await this.fetchRequest(
      `${GITHUB_API_BASE_URL}/repos/${owner}/${repository}/pulls/${input.number}`,
      {
        method: "GET",
        headers: githubApiHeaders(token),
      },
    );
    if (!response.ok) {
      throw new Error(
        `GitHub pull request lookup failed (${response.status}).`,
      );
    }

    const pullRequest = githubPullRequestSchema.parse(
      await response.json(),
    );
    const externalId = String(pullRequest.id);
    if (externalId !== input.externalId) {
      throw new Error(
        "GitHub pull request lookup returned an unexpected pull request.",
      );
    }

    return {
      externalId,
      number: pullRequest.number,
      draft: pullRequest.draft,
      state: pullRequest.merged
        ? "merged"
        : pullRequest.state,
      baseRef: pullRequest.base.ref,
      baseRevision: pullRequest.base.sha,
      headRevision: pullRequest.head.sha,
      sourceUpdatedAt: new Date(pullRequest.updated_at),
    };
  }
}
