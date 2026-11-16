import type { AgentActivityStore } from "@doxahq/api/repositories/agent-activity";
import type { AgentLiveEventStore } from "@doxahq/api/repositories/agent-live-events";
import type { AgentActor } from "@doxahq/api/services/agent-access/actor";
import type { ProjectAccessPolicy } from "@doxahq/api/services/agent-access/project-access-policy";
import type { DocsPageChange } from "@doxahq/api/services/docs-content/page-changes";
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
  readonly liveEvents: AgentLiveEventStore;
  readonly logger: McpLogger;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly now: () => number;
}

/** What one tool call proved and changed. It feeds the live activity. */
export interface ToolCallRecord {
  /** The project that the tool passed the access policy for. */
  projectId: string | null;
  pageChanges: readonly DocsPageChange[];
}

export function newToolCallRecord(): ToolCallRecord {
  return { projectId: null, pageChanges: [] };
}

export interface ToolContextOptions {
  /**
   * Billing spec 11: count this call against the daily tool-call quota of
   * the project's account, once, after the access policy allowed it. Off
   * for the tools without a project (`list_projects`, `get_account`, ...).
   */
  readonly countsToolCall?: boolean;
}

export function createToolContext(
  context: McpRequestContext,
  record: ToolCallRecord = newToolCallRecord(),
  options: ToolContextOptions = {},
): ToolContext {
  const { actor, policy, services, actions } = context;
  let counted = false;
  return {
    actor,
    services,
    actions,
    async authorize(projectId, capability) {
      const decision = await policy.authorize(actor, projectId, capability);
      if (!decision.allowed) throw new AccessDeniedError(decision.reason);
      record.projectId = decision.project.projectId;
      // Only after the policy allowed the project, so a call can never
      // spend the quota of an account the actor has no access to.
      const billing = services?.billing;
      if (options.countsToolCall && !counted && billing) {
        counted = true;
        await billing.consumeToolCall(decision.project.projectId);
      }
      return decision.project;
    },
    listAccessibleProjects: () => policy.listAccessibleProjects(actor),
    recordPageChanges(changes) {
      record.pageChanges = changes;
    },
  };
}
