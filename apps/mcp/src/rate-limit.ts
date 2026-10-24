import type { AgentActor } from "@doxahq/api/services/agent-access/actor";
import type { ToolCost } from "./tool-definition";

/**
 * Requests per 60 seconds (spec 13.1). These stop abuse; they are not quotas.
 * The binding config in `wrangler.json` must match; a test checks it.
 */
export const RATE_LIMITS_PER_MINUTE: Record<ToolCost, number> = {
  read: 600,
  write: 120,
  expensive: 20,
};

export const RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

export interface McpRateLimiter {
  allow(cost: ToolCost, actor: AgentActor): Promise<boolean>;
}

export type RateLimitBindings = Record<ToolCost, RateLimit>;

/** Expensive calls count per user, so many clients cannot multiply the budget. */
export function rateLimitKey(cost: ToolCost, actor: AgentActor): string {
  const { userId } = actor.principal;
  return cost === "expensive" ? userId : `${userId}:${actor.channel.clientId}`;
}

export function createRateLimiter(bindings: RateLimitBindings): McpRateLimiter {
  return {
    async allow(cost, actor) {
      const outcome = await bindings[cost].limit({
        key: rateLimitKey(cost, actor),
      });
      return outcome.success;
    },
  };
}
