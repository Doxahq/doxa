import type { Env } from "../../env";
import { OAuthNotConfiguredError, requireOAuthConfig, type OAuthSettings } from "../oauth/oauth-config";

/** The whole time to open the link, sign in, and enter the code. Opening the link does not extend it. */
export const CLAIM_TTL_SECONDS = 300;
/** The agent polls every few seconds, so an approved claim needs only a short window. */
export const APPROVED_CLAIM_REDEEM_SECONDS = 300;
export const POLL_INTERVAL_SECONDS = 5;
export const MAX_USER_CODE_ATTEMPTS = 5;
/** Per email and IP, so that a stranger cannot use up the budget of a victim's email. */
export const MAX_CLAIMS_PER_LOGIN_HINT_AND_IP_PER_HOUR = 5;
export const MAX_CLAIMS_PER_LOGIN_HINT_PER_HOUR = 20;
export const MAX_CLAIMS_PER_CLIENT_IP_PER_HOUR = 20;
export const AGENT_TOKEN_TTL_SECONDS = 90 * 24 * 3600;
export const MAX_ACTIVE_AGENT_TOKENS_PER_USER = 25;
/** `last_used_at` drives a limit of 30 days, so one write per hour is precise enough. */
export const AGENT_TOKEN_TOUCH_INTERVAL_SECONDS = 3600;

export type AgentSignupSettings = OAuthSettings & Pick<Env, "AGENT_SIGNUP_ENABLED">;

export interface AgentSignupConfig {
  readonly issuer: string;
  readonly mcpResource: string;
}

/** Thrown when the claim flow is switched off. Routes answer `503`. */
export class AgentSignupDisabledError extends Error {
  constructor() {
    super("Agent signup is switched off.");
    this.name = "AgentSignupDisabledError";
  }
}

/** The switch fails closed: only the exact value `true` opens the claim flow. */
export function isAgentSignupEnabled(env: Pick<Env, "AGENT_SIGNUP_ENABLED">): boolean {
  return env.AGENT_SIGNUP_ENABLED?.trim() === "true";
}

/** @throws AgentSignupDisabledError or OAuthNotConfiguredError */
export function requireAgentSignupConfig(env: AgentSignupSettings): AgentSignupConfig {
  if (!isAgentSignupEnabled(env)) throw new AgentSignupDisabledError();
  return requireOAuthConfig(env).config;
}

export function isAgentSignupUnavailable(
  cause: unknown,
): cause is AgentSignupDisabledError | OAuthNotConfiguredError {
  return cause instanceof AgentSignupDisabledError || cause instanceof OAuthNotConfiguredError;
}
