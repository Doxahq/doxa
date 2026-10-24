import {
  AuthorizationError,
  CimdFetchError,
  type AuthRequest,
} from "@cloudflare/workers-oauth-provider";
import type { Env } from "../../env";
import { authorizeErrorPage } from "./authorize-error-page";
import { oauthApiFromEnv, type OAuthApi } from "./authorization-server";
import { requireOAuthConfig } from "./oauth-config";
import {
  KvPendingConsentStore,
  newConsentId,
  type PendingConsentStore,
} from "./pending-consent-store";

export interface AuthorizeHandlerDependencies {
  oauth: Pick<OAuthApi, "parseAuthRequest" | "lookupClient">;
  consents: PendingConsentStore;
  now: () => Date;
  newConsentId: () => string;
}

type ParsedAuthorization =
  | { readonly ok: true; readonly authRequest: AuthRequest; readonly clientName: string | null }
  | { readonly ok: false; readonly response: Response };

/** Spec 6.5 steps 2 to 4: check the request, park it, send the user to consent. */
export class AuthorizeHandler {
  constructor(private readonly deps: AuthorizeHandlerDependencies) {}

  static fromEnv(env: Env): AuthorizeHandler {
    const { env: oauthEnv } = requireOAuthConfig(env);
    return new AuthorizeHandler({
      oauth: oauthApiFromEnv(env),
      consents: new KvPendingConsentStore(oauthEnv.OAUTH_KV),
      now: () => new Date(),
      newConsentId,
    });
  }

  async handle(request: Request, webOrigin: string): Promise<Response> {
    const parsed = await this.parse(request);
    if (!parsed.ok) return parsed.response;

    const consentId = this.deps.newConsentId();
    await this.deps.consents.save(consentId, {
      authRequest: parsed.authRequest,
      client: { clientId: parsed.authRequest.clientId, clientName: parsed.clientName },
      createdAt: this.deps.now().toISOString(),
    });
    const consentUrl = new URL("/oauth/consent", webOrigin);
    consentUrl.searchParams.set("id", consentId);
    return redirect(consentUrl.href);
  }

  private async parse(request: Request): Promise<ParsedAuthorization> {
    try {
      const authRequest = await this.deps.oauth.parseAuthRequest(request);
      const client = await this.deps.oauth.lookupClient(authRequest.clientId);
      if (client === null) {
        return { ok: false, response: authorizeErrorPage("The agent is not registered.") };
      }
      return { ok: true, authRequest, clientName: client.clientName ?? null };
    } catch (cause) {
      return { ok: false, response: authorizationFailure(cause) };
    }
  }
}

function authorizationFailure(cause: unknown): Response {
  if (cause instanceof AuthorizationError) {
    return cause.redirectTo ? redirect(cause.redirectTo) : authorizeErrorPage(cause.description);
  }
  if (cause instanceof CimdFetchError) {
    return authorizeErrorPage("The agent's client metadata document could not be loaded.");
  }
  throw cause;
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}
