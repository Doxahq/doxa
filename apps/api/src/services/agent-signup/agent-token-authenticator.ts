import type { ValidatedAccessToken } from "@cloudflare/workers-oauth-provider";
import {
  AGENT_GRANT_PROPS_VERSION,
  AGENT_TOKEN_CLIENT_ID_PREFIX,
  agentGrantPropsSchema,
  type AgentGrantProps,
} from "@doxahq/contracts/agent-access";
import type { DbEnv } from "@doxahq/db";
import { toSafeErrorLog } from "../../http/error-log";
import { AgentTokenRepository, type AgentTokenRecord, type AgentTokenStore } from "../../repositories/agent-tokens";
import { requireOAuthConfig, type OAuthSettings } from "../oauth/oauth-config";
import { AGENT_TOKEN_TOUCH_INTERVAL_SECONDS } from "./agent-signup-config";
import { sha256Hex } from "./agent-signup-secrets";

export interface AgentTokenAuthenticatorDependencies {
  tokens: Pick<AgentTokenStore, "findActiveByHash" | "touch">;
  mcpResource: string;
  now: () => Date;
}

/** Turns an agent token into the same result as an OAuth access token. */
export class AgentTokenAuthenticator {
  constructor(private readonly deps: AgentTokenAuthenticatorDependencies) {}

  static fromEnv(env: OAuthSettings & DbEnv): AgentTokenAuthenticator {
    return new AgentTokenAuthenticator({
      tokens: new AgentTokenRepository(env),
      mcpResource: requireOAuthConfig(env).config.mcpResource,
      now: () => new Date(),
    });
  }

  async validate(resource: string, token: string): Promise<ValidatedAccessToken<AgentGrantProps> | null> {
    if (resource !== this.deps.mcpResource) return null;
    const now = this.deps.now();
    const record = await this.deps.tokens.findActiveByHash(await sha256Hex(token), now);
    if (record === null) return null;
    const props = agentGrantPropsSchema.safeParse(toGrantProps(record));
    if (!props.success) return null;
    await this.touch(record, now);
    return {
      props: props.data,
      audience: this.deps.mcpResource,
      expiresAt: Math.floor(record.expiresAt.getTime() / 1000),
      scope: record.scopes,
      userId: record.userId,
      // Per token: branch and upload ownership compare client IDs, so two agents must not share one.
      clientId: `${AGENT_TOKEN_CLIENT_ID_PREFIX}${record.grantRef}`,
    };
  }

  /** A failed write must not reject the agent. The next request writes the time again. */
  private async touch(record: AgentTokenRecord, now: Date): Promise<void> {
    const staleBefore = new Date(now.getTime() - AGENT_TOKEN_TOUCH_INTERVAL_SECONDS * 1000);
    if (record.lastUsedAt !== null && record.lastUsedAt >= staleBefore) return;
    try {
      await this.deps.tokens.touch(record.id, now, staleBefore);
    } catch (cause) {
      console.error("Agent token last-use update failed.", toSafeErrorLog(cause));
    }
  }
}

function toGrantProps(record: AgentTokenRecord): unknown {
  return {
    version: AGENT_GRANT_PROPS_VERSION,
    grantRef: record.grantRef,
    userId: record.userId,
    clientName: record.clientName,
    projectScope: record.projectScope,
  };
}
