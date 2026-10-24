import type { AgentActivityStore } from "@doxahq/api/repositories/agent-activity";
import type { AgentActor } from "@doxahq/api/services/agent-access/actor";
import type { ProjectAccessPolicy } from "@doxahq/api/services/agent-access/project-access-policy";
import { AccessDeniedError } from "./errors";
import type { McpLogger } from "./logger";
import type { McpRateLimiter } from "./rate-limit";
import type { McpServices } from "./services/mcp-services";
import type { PlatformActions } from "./services/platform-actions";
import type { ToolContext } from "./tool-definition";

/** Everything one MCP request needs. Built once per request, then discarded. */
export interface McpRequestContext {
  /** Matches the log line and any error the agent sees. */
  readonly requestId: string;
  readonly actor: AgentActor;
  readonly policy: ProjectAccessPolicy;
  readonly services: McpServices;
  readonly actions: PlatformActions;
  readonly limiter: McpRateLimiter;
  readonly activity: AgentActivityStore;
  readonly logger: McpLogger;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly now: () => number;
}

export function createToolContext(context: McpRequestContext): ToolContext {
  const { actor, policy, services, actions } = context;
  return {
    actor,
    services,
    actions,
    async authorize(projectId, capability) {
      const decision = await policy.authorize(actor, projectId, capability);
      if (!decision.allowed) throw new AccessDeniedError(decision.reason);
      return decision.project;
    },
    listAccessibleProjects: () => policy.listAccessibleProjects(actor),
  };
}
