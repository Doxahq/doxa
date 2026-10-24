import { createAuth } from "@doxahq/auth";
import { createApiRouter } from "./http/app";
import { handleCurrentUser } from "./http/auth";
import { corsPolicy, csrfProtection, securityHeaders } from "./http/middleware";
import { toSafeErrorLog } from "./http/error-log";
import { withRequestScope, type ScopedFetch } from "./http/request-scope";
import { error, json, notFound } from "./http/response";
import { createApprovalRequestLinkRoutes } from "./routes/approval-requests";
import { createUserApprovalSettingsRoutes } from "./routes/approval-settings";
import {
  createAgentAccessRoutes,
  createOAuthAuthorizeRoutes,
} from "./routes/agent-access";
import { createEmailPreferencesRoutes, createEmailUnsubscribeRoutes } from "./routes/email";
import { createGitHubRoutes } from "./routes/github";
import { createInternalRoutes } from "./routes/internal";
import { createJobRoutes } from "./routes/jobs";
import { createProjectRoutes } from "./routes/projects";
import { createSignInRoutes } from "./routes/sign-in";
import { createTeamInviteRoutes, createTeamRoutes } from "./routes/teams";
import { oauthProviderDispatch } from "./services/oauth/provider-dispatch";

/**
 * The public HTTP API: every route, with the OAuth provider, security
 * headers, CORS and CSRF in front. The Worker and the Node server both serve
 * it through `createApiRequestHandler`.
 */
export function createApiApp() {
  const app = createApiRouter();

  // First, so provider paths skip the Hono CORS, CSRF, and header middleware:
  // the provider owns their rules (spec 6.2).
  app.use("*", oauthProviderDispatch());
  app.use("*", securityHeaders());
  app.use("*", corsPolicy());
  app.use("*", csrfProtection());

  app.get("/health", () => json({ ok: true, service: "doxa-api" }));

  app.all("/api/auth", (context) => {
    const auth = createAuth(context.env, context.req.raw, context.executionCtx);
    return auth.handler(context.req.raw);
  });

  app.all("/api/auth/*", (context) => {
    const auth = createAuth(context.env, context.req.raw, context.executionCtx);
    return auth.handler(context.req.raw);
  });

  app.get("/me", (context) => handleCurrentUser(context));
  app.route("/sign-in", createSignInRoutes());
  app.route("/github", createGitHubRoutes());
  app.route("/projects", createProjectRoutes());
  app.route("/jobs", createJobRoutes());
  app.route("/internal", createInternalRoutes());
  app.route("/oauth", createOAuthAuthorizeRoutes());
  app.route("/agent-access", createAgentAccessRoutes());
  app.route("/approval-requests", createApprovalRequestLinkRoutes());
  app.route("/approval-settings", createUserApprovalSettingsRoutes());
  app.route("/teams", createTeamRoutes());
  app.route("/team-invites", createTeamInviteRoutes());
  app.route("/email-preferences", createEmailPreferencesRoutes());
  app.route("/email", createEmailUnsubscribeRoutes());

  app.notFound(() => notFound());

  app.onError((err) => {
    console.error("Unhandled request error.", toSafeErrorLog(err));
    return error("Internal server error.", 500);
  });

  return app;
}

/**
 * One API request: one database scope (closed after the response and its
 * background work), plus the per-request response headers.
 */
export function createApiRequestHandler(app = createApiApp()): ScopedFetch {
  return withRequestScope((request, env, context) => app.fetch(request, env, context));
}
