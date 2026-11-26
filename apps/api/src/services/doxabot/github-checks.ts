import type {
  CreateReviewRunInput,
  UpdateReviewRunInput,
} from "@doxahq/contracts";
import type { Env } from "../../env";
import type { ReviewRunJobContext } from "../../repositories/jobs";
import {
  createInstallationAccessToken,
  type InstallationAccessTokenScope,
} from "../github-app";
import {
  GITHUB_API_BASE_URL,
  githubApiHeaders,
  parseGitHubRepositoryId,
} from "./github-api";
import type { ReviewRunProviderAdapter } from "./review-runs";

import { DOXA_DOCUMENTATION_PREVIEW_CHECK } from "./preview-check-identity";

export { DOXA_DOCUMENTATION_PREVIEW_CHECK };

export interface GitHubInstallationTokenRequest {
  installationId: string;
  scope: InstallationAccessTokenScope;
}

export interface GitHubChecksDependencies {
  createInstallationToken(
    input: GitHubInstallationTokenRequest,
  ): Promise<string>;
  fetch: typeof fetch;
}

const GITHUB_REVIEW_RUN_PERMISSIONS: Record<string, "read" | "write"> = {
  metadata: "read",
  contents: "read",
  pull_requests: "read",
  checks: "write",
};

export class GitHubChecksAdapter implements ReviewRunProviderAdapter {
  private readonly fetchRequest: typeof fetch;

  constructor(private readonly dependencies: GitHubChecksDependencies) {
    this.fetchRequest = dependencies.fetch.bind(globalThis);
  }

  static fromEnv(env: Env): GitHubChecksAdapter {
    return new GitHubChecksAdapter({
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

  async find(
    context: ReviewRunJobContext,
  ): Promise<{ externalRunId: string } | null> {
    const token = await this.createRepositoryToken(context);
    const query = new URLSearchParams({
      check_name: DOXA_DOCUMENTATION_PREVIEW_CHECK,
      filter: "all",
      per_page: "100",
    });
    const response = await this.fetchRequest(
      `${commitCheckRunsUrl(context)}?${query.toString()}`,
      {
        method: "GET",
        headers: githubApiHeaders(token),
      },
    );

    return parseCheckRunListResponse(response, context.jobId);
  }

  async create(
    context: ReviewRunJobContext,
    input: CreateReviewRunInput,
  ): Promise<{ externalRunId: string }> {
    const token = await this.createRepositoryToken(context);
    const response = await this.fetchRequest(
      checkRunsUrl(context),
      {
        method: "POST",
        headers: githubApiHeaders(token),
        body: JSON.stringify({
          name: DOXA_DOCUMENTATION_PREVIEW_CHECK,
          head_sha: input.sourceRevision,
          external_id: context.jobId,
          ...githubReviewRunFields(input),
        }),
      },
    );

    return parseCheckRunResponse(response, "create");
  }

  async update(
    context: ReviewRunJobContext,
    input: UpdateReviewRunInput,
  ): Promise<{ externalRunId: string }> {
    const token = await this.createRepositoryToken(context);
    const response = await this.fetchRequest(
      `${checkRunsUrl(context)}/${encodeURIComponent(input.externalRunId)}`,
      {
        method: "PATCH",
        headers: githubApiHeaders(token),
        body: JSON.stringify({
          name: DOXA_DOCUMENTATION_PREVIEW_CHECK,
          external_id: context.jobId,
          ...githubReviewRunFields(input),
        }),
      },
    );

    return parseCheckRunResponse(response, "update");
  }

  private async createRepositoryToken(
    context: ReviewRunJobContext,
  ): Promise<string> {
    const repositoryId = parseGitHubRepositoryId(
      context.repository.externalId,
    );
    return this.dependencies.createInstallationToken({
      installationId: context.repository.installationExternalId,
      scope: {
        repositoryIds: [repositoryId],
        permissions: GITHUB_REVIEW_RUN_PERMISSIONS,
      },
    });
  }
}

function githubReviewRunFields(
  input: CreateReviewRunInput | UpdateReviewRunInput,
): Record<string, unknown> {
  return {
    status: input.status,
    ...(input.conclusion ? { conclusion: input.conclusion } : {}),
    ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
    ...(input.actions ? { actions: input.actions } : {}),
    output: {
      title: input.title,
      summary: input.summary,
    },
  };
}

function checkRunsUrl(context: ReviewRunJobContext): string {
  return `${repositoryUrl(context)}/check-runs`;
}

function commitCheckRunsUrl(context: ReviewRunJobContext): string {
  const revision = encodeURIComponent(context.targetRevision);
  return `${repositoryUrl(context)}/commits/${revision}/check-runs`;
}

function repositoryUrl(context: ReviewRunJobContext): string {
  const owner = encodeURIComponent(context.repository.owner);
  const repository = encodeURIComponent(context.repository.name);
  return `${GITHUB_API_BASE_URL}/repos/${owner}/${repository}`;
}

async function parseCheckRunResponse(
  response: Response,
  operation: "create" | "update",
): Promise<{ externalRunId: string }> {
  if (!response.ok) {
    throw new Error(
      `GitHub check run ${operation} failed (${response.status}).`,
    );
  }

  const payload: unknown = await response.json();
  const externalRunId = parseCheckRunId(property(payload, "id"));
  if (externalRunId === null) {
    throw new Error(
      `GitHub check run ${operation} response did not include a valid ID.`,
    );
  }

  return { externalRunId };
}

async function parseCheckRunListResponse(
  response: Response,
  jobId: string,
): Promise<{ externalRunId: string } | null> {
  if (!response.ok) {
    throw new Error(
      `GitHub check run lookup failed (${response.status}).`,
    );
  }

  const payload: unknown = await response.json();
  const checkRuns = property(payload, "check_runs");
  if (!Array.isArray(checkRuns)) {
    throw new Error(
      "GitHub check run lookup response did not include a check-runs list.",
    );
  }

  for (const checkRun of checkRuns) {
    if (property(checkRun, "external_id") !== jobId) continue;

    const externalRunId = parseCheckRunId(property(checkRun, "id"));
    if (externalRunId === null) {
      throw new Error(
        "GitHub check run lookup response included a matching run without a valid ID.",
      );
    }
    return { externalRunId };
  }

  return null;
}

function parseCheckRunId(value: unknown): string | null {
  if (
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value > 0) ||
    (typeof value === "string" && /^[1-9]\d*$/.test(value))
  ) {
    return String(value);
  }
  return null;
}

function property(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? Reflect.get(value, key)
    : undefined;
}
