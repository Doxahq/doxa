import type { ModelAccessToken } from "@doxahq/contracts";
import { z } from "zod";

/**
 * Mints short-lived Anthropic access tokens with Workload Identity Federation:
 * a JWT that the cloud signs for this workload is exchanged at Anthropic for
 * a token that only allows inference in one workspace. No long-lived model
 * key is stored anywhere.
 *
 * Only the exchange lives here, so the module stays safe for Worker builds.
 * Where the JWT comes from (AWS STS on the origin) is injected.
 */

export const ANTHROPIC_TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
export const ANTHROPIC_AUDIENCE = "https://api.anthropic.com";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/**
 * The least lifetime a handed-out token has left. A generation stage runs up
 * to 45 minutes and cannot refresh its token, so the token must outlast it.
 */
export const MIN_TOKEN_LIFETIME_MS = 50 * 60_000;

export interface ModelFederationConfig {
  federationRuleId: string;
  organizationId: string;
  serviceAccountId: string;
  workspaceId: string;
}

export interface ModelTokenBroker {
  /** A token with at least `MIN_TOKEN_LIFETIME_MS` left. */
  getToken(): Promise<ModelAccessToken>;
}

export interface FederatedModelTokenBrokerDeps {
  config: ModelFederationConfig;
  /** A fresh identity JWT for each exchange: a JWT with a `jti` works once. */
  identityToken: () => Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

const errorResponseSchema = z.object({
  error: z.object({ type: z.string().optional(), message: z.string().optional() }).optional(),
});

export class ModelTokenExchangeError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = "ModelTokenExchangeError";
  }
}

export class FederatedModelTokenBroker implements ModelTokenBroker {
  private cached: { token: string; expiresAtMs: number } | null = null;
  private pending: Promise<ModelAccessToken> | null = null;
  private readonly fetchRequest: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly deps: FederatedModelTokenBrokerDeps) {
    this.fetchRequest = (deps.fetch ?? fetch).bind(globalThis);
    this.now = deps.now ?? Date.now;
  }

  getToken(): Promise<ModelAccessToken> {
    const cached = this.cached;
    if (cached && cached.expiresAtMs - this.now() >= MIN_TOKEN_LIFETIME_MS) {
      return Promise.resolve(toDto(cached));
    }
    // One exchange at a time: concurrent stages share it.
    this.pending ??= this.exchange().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async exchange(): Promise<ModelAccessToken> {
    const assertion = await this.deps.identityToken();
    const { config } = this.deps;
    const response = await this.fetchRequest(ANTHROPIC_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: JWT_BEARER_GRANT,
        assertion,
        federation_rule_id: config.federationRuleId,
        organization_id: config.organizationId,
        service_account_id: config.serviceAccountId,
        workspace_id: config.workspaceId,
      }),
    });

    if (!response.ok) throw await exchangeFailure(response);

    const parsed = tokenResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new ModelTokenExchangeError("The Anthropic token response was not in the expected shape.");
    }

    const lifetimeMs = parsed.data.expires_in * 1000;
    if (lifetimeMs < MIN_TOKEN_LIFETIME_MS) {
      throw new ModelTokenExchangeError(
        `The Anthropic token lasts ${parsed.data.expires_in} seconds, shorter than a generation stage. ` +
          "Set the federation rule's token lifetime to 3600 seconds.",
      );
    }

    this.cached = { token: parsed.data.access_token, expiresAtMs: this.now() + lifetimeMs };
    return toDto(this.cached);
  }
}

/** The error type and message only: the response never holds the token, but the request held the JWT. */
async function exchangeFailure(response: Response): Promise<ModelTokenExchangeError> {
  const body = errorResponseSchema.safeParse(await response.json().catch(() => null));
  const detail = body.success && body.data.error
    ? [body.data.error.type, body.data.error.message].filter(Boolean).join(": ")
    : "no error detail";
  return new ModelTokenExchangeError(
    `The Anthropic token exchange failed (${response.status}, ${detail}). ` +
      "The authentication history in the Claude Console shows the reason.",
    response.status,
  );
}

function toDto(cached: { token: string; expiresAtMs: number }): ModelAccessToken {
  return { token: cached.token, expiresAt: new Date(cached.expiresAtMs).toISOString() };
}
