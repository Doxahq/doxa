import { WorkerEntrypoint } from "cloudflare:workers";
import type { ValidatedAccessToken } from "@cloudflare/workers-oauth-provider";
import { agentGrantPropsSchema, type AgentGrantProps } from "@doxahq/contracts/agent-access";
import { authorizationServerFor } from "./authorization-server";
import { requireOAuthConfig, type OAuthSettings } from "./oauth-config";

export type ValidatedAgentToken = ValidatedAccessToken<AgentGrantProps>;

/**
 * Called by the MCP Worker over a service binding (spec 6.2). Props are
 * parsed here too, so a token with an unknown props version is invalid.
 * Its env type lists only the entries it reads.
 */
export class OAuthTokenValidator extends WorkerEntrypoint<OAuthSettings> {
  async validateToken(resource: string, token: string): Promise<ValidatedAgentToken | null> {
    const { config, env } = requireOAuthConfig(this.env);
    const validated = await authorizationServerFor(config).validateToken<unknown>(
      resource,
      token,
      env,
    );
    return validated === null ? null : withParsedProps(validated);
  }
}

export function withParsedProps(
  validated: ValidatedAccessToken<unknown>,
): ValidatedAgentToken | null {
  const props = agentGrantPropsSchema.safeParse(validated.props);
  return props.success ? { ...validated, props: props.data } : null;
}
