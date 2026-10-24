import { approveAgentConsentInputSchema } from "@doxahq/contracts/agent-access";
import type { Env } from "../env";
import { getWebOrigin } from "../http/access";
import { createApiRouter, type ApiApp } from "../http/app";
import { withUser } from "../http/auth";
import { json, notFound, validationError } from "../http/response";
import { parseValidatedJson } from "../http/validation";
import { AuthorizeHandler } from "../services/oauth/authorize-handler";
import { ConsentService } from "../services/oauth/consent-service";
import { GrantsService } from "../services/oauth/grants-service";
import { OAuthNotConfiguredError } from "../services/oauth/oauth-config";
import { oauthNotConfiguredResponse } from "../services/oauth/provider-dispatch";

/** How the routes get their services; tests pass fakes. */
export interface AgentAccessServices {
  authorize(env: Env): AuthorizeHandler;
  consents(env: Env): ConsentService;
  grants(env: Env): GrantsService;
}

const servicesFromEnv: AgentAccessServices = {
  authorize: (env) => AuthorizeHandler.fromEnv(env),
  consents: (env) => ConsentService.fromEnv(env),
  grants: (env) => GrantsService.fromEnv(env),
};

/** `GET /oauth/authorize`. The provider serves every other `/oauth/*` path. */
export function createOAuthAuthorizeRoutes(services = servicesFromEnv): ApiApp {
  const app = createApiRouter();
  app.get("/authorize", (context) =>
    run(() =>
      services
        .authorize(context.env)
        .handle(context.req.raw, getWebOrigin(context.req.raw, context.env)),
    ),
  );
  return app;
}

/** Consent and connected-agent routes for the signed-in user (spec 6.5, 6.7). */
export function createAgentAccessRoutes(services = servicesFromEnv): ApiApp {
  const app = createApiRouter();

  app.get("/consents/:consentId", (context) =>
    withUser(context, (userId) =>
      run(async () => {
        const result = await services
          .consents(context.env)
          .get(context.req.param("consentId"), userId);
        return result.kind === "found" ? json(result.details) : notFound();
      }),
    ),
  );

  app.post("/consents/:consentId/approve", (context) =>
    withUser(context, (userId) =>
      run(async () => {
        const input = await parseValidatedJson(
          context,
          approveAgentConsentInputSchema,
          "Invalid consent approval request.",
        );
        if (!input.ok) return input.response;
        const result = await services
          .consents(context.env)
          .approve(context.req.param("consentId"), userId, input.data);
        if (result.kind === "approved") return json({ redirectTo: result.redirectTo });
        if (result.kind === "rejected") {
          return validationError(result.issues, "The consent choices are not valid.");
        }
        return notFound();
      }),
    ),
  );

  app.post("/consents/:consentId/deny", (context) =>
    withUser(context, () =>
      run(async () => {
        const result = await services.consents(context.env).deny(context.req.param("consentId"));
        return result.kind === "denied" ? json({ redirectTo: result.redirectTo }) : notFound();
      }),
    ),
  );

  app.get("/grants", (context) =>
    withUser(context, (userId) =>
      run(async () => json({ grants: await services.grants(context.env).list(userId) })),
    ),
  );

  app.delete("/grants/:grantId", (context) =>
    withUser(context, (userId) =>
      run(async () => {
        const result = await services
          .grants(context.env)
          .revoke(userId, context.req.param("grantId"));
        return result.kind === "revoked" ? new Response(null, { status: 204 }) : notFound();
      }),
    ),
  );

  return app;
}

async function run(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (cause) {
    if (cause instanceof OAuthNotConfiguredError) return oauthNotConfiguredResponse(cause);
    throw cause;
  }
}
