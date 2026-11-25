import { createAuth } from "@doxahq/auth";
import type { GitHubRepositoriesRefreshResponseDto, GitHubRepositoryDto } from "@doxahq/contracts";
import { error, json } from "../http/response";
import type { Env } from "../env";
import {
  GitHubRepository,
  type RefreshableInstallation,
  type RepositoryRefreshClaim,
} from "../repositories/github";
import {
  GitHubRepositoryListError,
  isLocalInstallation,
  listUserInstallationRepositories,
  type InstallationRepositoryRecord,
  type ListUserInstallationRepositoriesOptions,
  type UserInstallationRepositories,
} from "./github-app";

/** One refresh per installation in this time. Two clicks at once make one refresh. */
export const REPOSITORY_REFRESH_COOLDOWN_SECONDS = 60;

/**
 * The refresh stops before the next page when fewer GitHub requests than this
 * are left in the user's hourly budget (5,000). GitHub shares that budget with
 * every app and token of the user, so a refresh never uses the last of it.
 */
export const REPOSITORY_REFRESH_RATE_LIMIT_FLOOR = 500;

/** Rows written at the same time, so a large list does not hold every database connection. */
const RECORD_BATCH_SIZE = 25;

export type RepositoryRefreshResult =
  | { kind: "refreshed"; repositories: GitHubRepositoryDto[]; complete: boolean }
  /** The user owns no active installation: they must connect GitHub first. */
  | { kind: "not_connected" }
  /**
   * Doxa has no GitHub sign-in token of the user that GitHub accepts for the
   * list: the user signs in another way, or the token is revoked or expired.
   */
  | { kind: "sign_in_unavailable" }
  | { kind: "cooldown"; retryAfterSeconds: number }
  | { kind: "rate_limited"; retryAfterSeconds: number | null }
  | { kind: "github_unavailable" };

export interface RepositoryRefreshDependencies {
  installations: {
    listRefreshableInstallations(userId: string): Promise<RefreshableInstallation[]>;
    claimRepositoryRefresh(
      installationRowId: string,
      now: Date,
      cooldownSeconds: number,
    ): Promise<RepositoryRefreshClaim>;
  };
  repositories: {
    recordRepository(input: InstallationRepositoryRecord & { installationId: string }): Promise<unknown>;
    listReposForUser(userId: string): Promise<GitHubRepositoryDto[]>;
  };
  /** The user's GitHub sign-in token, renewed when it expired. Null when Doxa has none. */
  userToken(userId: string): Promise<string | null>;
  listRepositories(
    userToken: string,
    installationId: string,
    options: ListUserInstallationRepositoriesOptions,
  ): Promise<UserInstallationRepositories>;
  now(): Date;
}

/**
 * Reads the repository list of the user's installations from GitHub again,
 * for a repository that no webhook added. It uses the user's GitHub sign-in
 * token, so it spends only that user's GitHub budget, and GitHub returns only
 * the repositories that the user can access.
 *
 * A refresh adds and updates rows. It never removes one: a row can carry a
 * project, and the webhooks record a repository that the app lost.
 *
 * Cost: one GitHub request per 100 repositories of each installation, pages
 * one after another. Limits: a cooldown per installation, the page cap of
 * the list, and a floor on the user's GitHub budget.
 */
export class GitHubRepositoryRefreshService {
  constructor(private readonly dependencies: RepositoryRefreshDependencies) {}

  static fromEnv(env: Env): GitHubRepositoryRefreshService {
    const repository = new GitHubRepository(env);
    return new GitHubRepositoryRefreshService({
      installations: repository,
      repositories: repository,
      userToken: (userId) => readGitHubSignInToken(env, userId),
      listRepositories: listUserInstallationRepositories,
      now: () => new Date(),
    });
  }

  async refresh(userId: string): Promise<RepositoryRefreshResult> {
    const { dependencies } = this;
    // A local installation has no GitHub list to read.
    const installations = (await dependencies.installations.listRefreshableInstallations(userId))
      .filter((installation) => !isLocalInstallation(installation.installationId));
    if (installations.length === 0) return { kind: "not_connected" };

    const token = await dependencies.userToken(userId);
    if (!token) return { kind: "sign_in_unavailable" };

    const now = dependencies.now();
    let refreshed = 0;
    let complete = true;
    let retryAfterSeconds = 0;
    for (const installation of installations) {
      const claim = await dependencies.installations.claimRepositoryRefresh(
        installation.id,
        now,
        REPOSITORY_REFRESH_COOLDOWN_SECONDS,
      );
      if (!claim.claimed) {
        retryAfterSeconds = Math.max(retryAfterSeconds, claim.retryAfterSeconds);
        continue;
      }

      let listed: UserInstallationRepositories;
      try {
        listed = await dependencies.listRepositories(token, installation.installationId, {
          minRateLimitRemaining: REPOSITORY_REFRESH_RATE_LIMIT_FLOOR,
        });
      } catch (caught) {
        const failure = refreshFailure(caught);
        // GitHub does not show this installation to the user any more, for
        // example after they left the organization. The others still refresh.
        if (failure === "installation_hidden") {
          complete = false;
          continue;
        }
        return failure;
      }

      await recordInBatches(listed.repositories, (repository) =>
        dependencies.repositories.recordRepository({ installationId: installation.id, ...repository }),
      );
      refreshed += 1;
      complete &&= listed.complete;
    }

    if (refreshed === 0 && retryAfterSeconds > 0) {
      return { kind: "cooldown", retryAfterSeconds };
    }
    return {
      kind: "refreshed",
      repositories: await dependencies.repositories.listReposForUser(userId),
      complete,
    };
  }
}

function refreshFailure(caught: unknown): Exclude<RepositoryRefreshResult, { kind: "refreshed" }> | "installation_hidden" {
  if (!(caught instanceof GitHubRepositoryListError)) {
    console.error("GitHub repository refresh failed.", caught instanceof Error ? caught.message : caught);
    return { kind: "github_unavailable" };
  }
  if (caught.rateLimited) return { kind: "rate_limited", retryAfterSeconds: caught.retryAfterSeconds };
  if (caught.status === 404) return "installation_hidden";
  if (caught.isAuthorizationRefusal) return { kind: "sign_in_unavailable" };
  console.error("GitHub repository refresh failed.", caught.message);
  return { kind: "github_unavailable" };
}

async function recordInBatches<T>(items: readonly T[], record: (item: T) => Promise<unknown>): Promise<void> {
  for (let start = 0; start < items.length; start += RECORD_BATCH_SIZE) {
    await Promise.all(items.slice(start, start + RECORD_BATCH_SIZE).map(record));
  }
}

/**
 * The user's GitHub sign-in token from Better Auth, renewed with its refresh
 * token when it expired. A trusted server call: no request, so Better Auth
 * acts on `userId`. Null when the user has no GitHub sign-in, or the renewal
 * failed.
 */
async function readGitHubSignInToken(env: Env, userId: string): Promise<string | null> {
  try {
    const { accessToken } = await createAuth(env).api.getAccessToken({
      body: { providerId: "github", userId },
    });
    return accessToken ?? null;
  } catch (caught) {
    console.warn("No usable GitHub sign-in token for a repository refresh.", {
      error: caught instanceof Error ? caught.message : String(caught),
    });
    return null;
  }
}

const MANAGE_ACCESS_HINT = "Use “Manage GitHub access” to update the list.";

/** The HTTP answer of `POST /github/repos/refresh`. */
export function repositoryRefreshResponse(result: RepositoryRefreshResult): Response {
  switch (result.kind) {
    case "refreshed":
      return json(
        { repositories: result.repositories, complete: result.complete } satisfies GitHubRepositoriesRefreshResponseDto,
        { headers: { "cache-control": "no-store" } },
      );
    case "not_connected":
      return error("Connect GitHub first.", 409, { code: "github_not_connected" });
    case "sign_in_unavailable":
      return error(`Doxa cannot read your repositories with your GitHub sign-in. ${MANAGE_ACCESS_HINT}`, 409, {
        code: "github_sign_in_unavailable",
      });
    case "cooldown":
      return withRetryAfter(
        error(`The list was refreshed less than a minute ago. Try again in ${result.retryAfterSeconds} s.`, 429, {
          code: "refresh_cooldown",
          retryAfterSeconds: result.retryAfterSeconds,
        }),
        result.retryAfterSeconds,
      );
    case "rate_limited":
      return withRetryAfter(
        error("GitHub limits the requests of your account now. Try again later.", 429, {
          code: "github_rate_limited",
          retryAfterSeconds: result.retryAfterSeconds,
        }),
        result.retryAfterSeconds,
      );
    case "github_unavailable":
      return error("GitHub could not list the repositories. Try again.", 502, { code: "github_unavailable" });
  }
}

function withRetryAfter(response: Response, seconds: number | null): Response {
  if (seconds !== null) response.headers.set("retry-after", String(seconds));
  return response;
}
