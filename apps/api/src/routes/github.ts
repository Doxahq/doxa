import { getCookie } from "hono/cookie";
import { readBodyText, readValidBody, requestBodyTooLarge } from "../http/body";
import { RequestBodyTooLarge } from "../http/bounded-body";
import { createApiRouter } from "../http/app";
import type { ApiApp, ApiContext } from "../http/app";
import type { Env } from "../env";
import { getWebOrigin } from "../http/access";
import { withUser } from "../http/auth";
import { error, json } from "../http/response";
import { GitHubRepository, type RepositoryBranchTarget } from "../repositories/github";
import {
  transferGitHubInstallationInputSchema,
  type GitHubInstallationsResponseDto,
} from "@doxahq/contracts";
import { GitHubLifecycleRepository, type GitHubInstaller } from "../repositories/github-lifecycle";
import { decideInstallationClaim } from "../services/github-install-owner";
import {
  GitHubAuthorizationError,
  exchangeUserAuthorizationCode,
  fetchGitHubTokenUser,
  findUserInstallation,
  type GitHubTokenUser,
  isLocalInstallation,
  listUserInstallationRepositories,
} from "../services/github-app";
import {
  INSTALL_NONCE_COOKIE,
  INSTALL_NONCE_COOKIE_PATH,
  INSTALL_STATE_TTL_SECONDS,
  InstallStateSigner,
  createInstallNonce,
  isInstallNonce,
  sameNonce,
} from "../services/github-install-state";
import { verifyGitHubWebhook } from "../services/github-webhook";
import {
  GitHubRepositoryRefreshService,
  repositoryRefreshResponse,
} from "../services/github-repository-refresh";
import {
  RepositoryBranchesService,
  RepositoryBranchesUnavailableError,
} from "../services/repository-branches";
import { DoxabotWebhookOrchestrator } from "../services/doxabot/webhook-orchestrator";
import { MergeGenerationScheduler } from "../services/doxabot/merge-generations";
import { productAnalyticsOf } from "../services/analytics/product-analytics";

export function createGitHubRoutes(): ApiApp {
  const app = createApiRouter();

  app.post("/webhook", async (context) => {
    const deliveryId = context.req.header("x-github-delivery");
    const eventName = context.req.header("x-github-event");
    if (!deliveryId || !eventName) {
      return error("Missing required GitHub webhook headers.", 400);
    }

    // Read before the signature check, so the size must be bounded first.
    let body: string;
    try {
      body = await readBodyText(context.req.raw, GITHUB_WEBHOOK_MAX_BYTES);
    } catch (caught) {
      if (caught instanceof RequestBodyTooLarge) return requestBodyTooLarge();
      throw caught;
    }
    const valid = await verifyGitHubWebhook(context.req.raw, context.env, body);
    if (!valid) return error("Invalid GitHub webhook signature.", 401);

    // Built on the first merge only: most deliveries record no merge.
    const orchestrator = DoxabotWebhookOrchestrator.fromEnv(context.env, {
      mergeTriggers: {
        recordMerge: (merge) =>
          MergeGenerationScheduler.fromEnv(context.env, (promise) =>
            context.executionCtx.waitUntil(promise),
          ).recordMerge(merge),
      },
    });
    const ingress = await orchestrator.ingest({
      deliveryId,
      eventName,
      rawBody: body,
    });
    if (ingress.outcome === "duplicate") {
      return json({ ok: true, outcome: "duplicate" });
    }

    const processing = orchestrator.processDelivery({
      provider: "github",
      deliveryId,
    });
    context.executionCtx.waitUntil(processing.catch((caught) => {
      console.error("Doxabot webhook processing failed.", caught);
    }));

    return json(
      { ok: true, outcome: "accepted" },
      { status: 202 },
    );
  });

  app.get("/install", (context) => {
    if (!context.env.GITHUB_APP_SLUG) {
      return error("GITHUB_APP_SLUG is required to start GitHub App installation.", 500);
    }

    return Response.redirect(`https://github.com/apps/${context.env.GITHUB_APP_SLUG}/installations/new`, 302);
  });

  // GitHub sends the person here after the install, with an installation_id
  // This route only starts a GitHub authorization. The installation
  // is linked in /install/authorize, after GitHub confirms that this person's
  // own account can access it.
  app.get("/install/callback", (context) =>
    withUser(context, async (userId) => {
      const installationId = context.req.query("installation_id");
      if (!installationId) {
        // The person asked an organization owner to install the App.
        if (context.req.query("setup_action") === "request") {
          return redirectToDashboard(context, "requested");
        }
        return error("Missing installation_id.", 400);
      }

      if (isLocalInstallation(installationId)) {
        return recordLocalInstallation(context, userId, installationId);
      }

      if (!GITHUB_INSTALLATION_ID_PATTERN.test(installationId)) {
        return error("Invalid installation_id.", 400);
      }
      if (!context.env.GITHUB_CLIENT_ID || !context.env.BETTER_AUTH_SECRET) {
        return error("GITHUB_CLIENT_ID and BETTER_AUTH_SECRET are required to connect a GitHub installation.", 500);
      }

      const nonce = createInstallNonce();
      const state = await new InstallStateSigner(context.env.BETTER_AUTH_SECRET).sign({
        userId,
        installationId,
        nonce,
        expiresAt: nowSeconds() + INSTALL_STATE_TTL_SECONDS,
      });
      const authorizeUrl = new URL(GITHUB_AUTHORIZE_URL);
      authorizeUrl.searchParams.set("client_id", context.env.GITHUB_CLIENT_ID);
      authorizeUrl.searchParams.set("redirect_uri", installAuthorizeRedirectUri(context.env));
      authorizeUrl.searchParams.set("state", state);

      return redirect(authorizeUrl.toString(), [
        installNonceCookie(context.env, nonce, INSTALL_STATE_TTL_SECONDS),
      ]);
    }),
  );

  app.get("/install/authorize", (context) =>
    withUser(context, async (userId) => {
      // The nonce cookie works once: every answer of this route clears it.
      const clearNonce = installNonceCookie(context.env, "", 0);
      const fail = (message: string, status: number) =>
        withSetCookies(error(message, status), [clearNonce]);

      if (!context.env.BETTER_AUTH_SECRET) {
        return fail("BETTER_AUTH_SECRET is required to connect a GitHub installation.", 500);
      }
      const state = await new InstallStateSigner(context.env.BETTER_AUTH_SECRET).verify(
        context.req.query("state") ?? "",
        nowSeconds(),
      );
      const cookieNonce = getCookie(context, INSTALL_NONCE_COOKIE);
      if (
        !state ||
        state.userId !== userId ||
        !isInstallNonce(cookieNonce) ||
        !sameNonce(state.nonce, cookieNonce)
      ) {
        return fail("The GitHub connection request expired or is not valid. Connect GitHub again.", 403);
      }

      const code = context.req.query("code");
      if (context.req.query("error") || !code) {
        return fail("GitHub authorization was not granted. Connect GitHub again.", 403);
      }

      let userToken: string;
      try {
        userToken = await exchangeUserAuthorizationCode(
          context.env,
          code,
          installAuthorizeRedirectUri(context.env),
        );
      } catch (caught) {
        if (caught instanceof GitHubAuthorizationError) {
          return fail("GitHub authorization failed. Connect GitHub again.", 403);
        }
        throw caught;
      }

      let access: Awaited<ReturnType<typeof findUserInstallation>>;
      try {
        access = await findUserInstallation(userToken, state.installationId);
      } catch (caught) {
        console.error("GitHub installation lookup failed.", caught instanceof Error ? caught.message : caught);
        return fail("GitHub could not be reached. Connect GitHub again.", 502);
      }
      if (!access) {
        return fail("Your GitHub account cannot access this GitHub App installation.", 403);
      }

      const repo = new GitHubRepository(context.env);
      let githubUser: GitHubTokenUser;
      let currentOwnerUserId: string | null;
      let installer: GitHubInstaller | null;
      try {
        [githubUser, currentOwnerUserId, installer] = await Promise.all([
          fetchGitHubTokenUser(userToken),
          repo.findInstallationOwner(access.installationId),
          new GitHubLifecycleRepository(context.env).findInstaller(access.installationId),
        ]);
      } catch (caught) {
        console.error("GitHub installation owner check failed.", caught instanceof Error ? caught.message : caught);
        return fail("GitHub could not be reached. Connect GitHub again.", 502);
      }
      const claim = decideInstallationClaim({
        userId,
        currentOwnerUserId,
        accountType: access.accountType,
        accountId: access.accountId,
        githubUserId: githubUser.githubUserId,
        installer,
      });
      switch (claim.outcome) {
        case "accept":
          break;
        case "installer_unknown":
          // GitHub sends the webhook a few seconds after the install. The
          // dashboard asks the user to try again with this installation.
          return withSetCookies(
            redirectToDashboard(context, "pending", access.installationId),
            [clearNonce],
          );
        case "not_installer":
          return fail(
            `Only the GitHub user who installed Doxabot on ${access.accountLogin} (${claim.installerLogin}) can connect it. Ask them to connect it and add you to their Doxa team.`,
            403,
          );
        case "not_account_owner":
          return fail(`Only the GitHub user ${access.accountLogin} can connect this installation.`, 403);
        case "owned_by_other_user":
          return fail("This GitHub installation is connected to another Doxa account.", 409);
      }

      const installation = await repo.recordInstallation({
        userId,
        installationId: access.installationId,
        accountLogin: access.accountLogin,
        accountType: access.accountType,
      });
      if (!installation) {
        return fail("This GitHub installation is connected to another Doxa account.", 409);
      }

      let listed: Awaited<ReturnType<typeof listUserInstallationRepositories>>;
      try {
        listed = await listUserInstallationRepositories(userToken, access.installationId);
      } catch (caught) {
        console.error("GitHub repository listing failed.", caught instanceof Error ? caught.message : caught);
        return fail("GitHub could not list the repositories. Connect GitHub again.", 502);
      }
      await Promise.all(
        listed.repositories.map((repository) =>
          repo.recordRepository({
            installationId: installation.id,
            ...repository,
          }),
        ),
      );
      // A repository that this user can no longer see loses its row, for
      // example after the user lost access to it on GitHub. Only a complete
      // list may remove rows: a list cut at the page cap misses real ones.
      if (listed.complete) {
        await repo.removeRepositoriesExcept(
          installation.id,
          listed.repositories.map((repository) => repository.githubRepoId),
        );
      }

      // The count only: repository names never leave Doxa.
      const repoCount = listed.repositories.length;
      productAnalyticsOf(context.env).capture({ name: "github_app_installed", distinctId: userId, properties: { repo_count: repoCount } });
      return withSetCookies(redirectToDashboard(context, "connected"), [clearNonce]);
    }),
  );

  // The installations that the user owns, and the users they can move one to.
  app.get("/installations", (context) =>
    withUser(context, async (userId) => {
      const repo = new GitHubRepository(context.env);
      const [installations, transferTargets] = await Promise.all([
        repo.listInstallationsForOwner(userId),
        repo.listOwnerTransferTargets(userId),
      ]);
      return json({ installations, transferTargets } satisfies GitHubInstallationsResponseDto);
    }),
  );

  // Moves an installation to another Doxa user (Decision 6). Only its owner
  // can, and only to a user who shares a Doxa team with them.
  app.post("/installations/:installationId/owner", (context) =>
    withUser(context, async (userId) => {
      const installationRowId = context.req.param("installationId");
      if (!UUID_PATTERN.test(installationRowId)) return error("Installation not found.", 404);
      const body = await readValidBody(context.req.raw, transferGitHubInstallationInputSchema);
      if (!body) return error("Choose the Doxa user to move the installation to.", 400);

      const result = await new GitHubRepository(context.env).transferInstallationOwner({
        installationRowId,
        fromUserId: userId,
        toUserId: body.userId,
      });
      if (result === "not_found") return error("Installation not found.", 404);
      if (result === "target_not_allowed") {
        return error("You can move an installation only to a member of one of your Doxa teams.", 403);
      }
      return json({ ok: true });
    }),
  );

  app.get("/repos", (context) =>
    withUser(context, async (userId) => {
      const repos = await new GitHubRepository(context.env).listReposForUser(userId);
      return json({ repositories: repos });
    }),
  );

  // Reads the repository list from GitHub again, for a repository that no
  // webhook added. It uses the user's GitHub sign-in, so it spends only their
  // GitHub budget. A cooldown per installation limits what clicks cost.
  app.post("/repos/refresh", (context) =>
    withUser(context, async (userId) =>
      repositoryRefreshResponse(await GitHubRepositoryRefreshService.fromEnv(context.env).refresh(userId)),
    ),
  );

  // The production branch picker of a new project. Only a repository of the
  // user's own installations answers.
  app.get("/repos/:repositoryId/branches", (context) =>
    withUser(context, async (userId) => {
      const repositoryId = context.req.param("repositoryId");
      if (!UUID_PATTERN.test(repositoryId)) return error("Repository not found.", 404);
      const target = await new GitHubRepository(context.env).getBranchTargetForUser(userId, repositoryId);
      if (!target) return error("Repository not found.", 404);
      return repositoryBranchesResponse(context.env, target);
    }),
  );

  return app;
}

/** `{ defaultBranch, branches, complete }`, or 502 when GitHub cannot answer. */
export async function repositoryBranchesResponse(
  env: Env,
  target: RepositoryBranchTarget,
): Promise<Response> {
  try {
    return json(await RepositoryBranchesService.fromEnv(env).list(target));
  } catch (caught) {
    if (caught instanceof RepositoryBranchesUnavailableError) {
      console.error("GitHub branch listing failed.", caught.message);
      return error("GitHub could not list the branches. Try again.", 502);
    }
    throw caught;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GitHub caps webhook payloads at 25 MB. */
const GITHUB_WEBHOOK_MAX_BYTES = 25 * 1024 * 1024;

/** GitHub installation IDs are positive integers. */
const GITHUB_INSTALLATION_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";

const LOCAL_API_ORIGIN = "http://localhost:8787";

/**
 * Development only: `local*` installations use LOCAL_GITHUB_TOKEN, which
 * production does not set. Without it, the route refuses them.
 */
async function recordLocalInstallation(
  context: ApiContext,
  userId: string,
  installationId: string,
): Promise<Response> {
  if (!context.env.LOCAL_GITHUB_TOKEN) {
    return error("Local installations need LOCAL_GITHUB_TOKEN.", 400);
  }

  const repo = new GitHubRepository(context.env);
  const installation = await repo.recordInstallation({
    userId,
    installationId,
    accountLogin: "local",
    accountType: "User",
  });
  if (!installation) {
    return error("This GitHub installation is connected to another Doxa account.", 409);
  }

  await repo.recordRepository({
    installationId: installation.id,
    githubRepoId: "local-doxa-demo",
    fullName: "local/doxa-demo",
    owner: "local",
    name: "doxa-demo",
  });
  return redirectToDashboard(context, "connected");
}

/** BETTER_AUTH_URL is the API's own public origin, for example https://api.doxa.so. */
function apiOrigin(env: Pick<Env, "BETTER_AUTH_URL">): string {
  return env.BETTER_AUTH_URL?.trim().replace(/\/+$/, "") || LOCAL_API_ORIGIN;
}

/** Must be one of the callback URLs in the GitHub App settings. */
function installAuthorizeRedirectUri(env: Pick<Env, "BETTER_AUTH_URL">): string {
  return `${apiOrigin(env)}/github/install/authorize`;
}

/** Host-only, so only the API host gets it. Max-Age 0 clears it. */
function installNonceCookie(env: Pick<Env, "BETTER_AUTH_URL">, value: string, maxAgeSeconds: number): string {
  const secure = apiOrigin(env).startsWith("https://") ? "; Secure" : "";
  return `${INSTALL_NONCE_COOKIE}=${value}; Path=${INSTALL_NONCE_COOKIE_PATH}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure}`;
}

function redirectToDashboard(
  context: ApiContext,
  outcome: "connected" | "requested" | "pending",
  installationId?: string,
): Response {
  const url = new URL("/dashboard", getWebOrigin(context.req.raw, context.env));
  url.searchParams.set("github", outcome);
  if (installationId) url.searchParams.set("installation_id", installationId);
  return redirect(url.toString());
}

function redirect(location: string, setCookies: string[] = []): Response {
  return withSetCookies(new Response(null, { status: 302, headers: { location } }), setCookies);
}

function withSetCookies(response: Response, setCookies: string[]): Response {
  for (const setCookie of setCookies) {
    response.headers.append("set-cookie", setCookie);
  }
  return response;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
