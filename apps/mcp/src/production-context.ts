import { createRequestDbScope } from "@doxahq/db";
import { AgentActivityRepository } from "@doxahq/api/repositories/agent-activity";
import { AgentLiveEventRepository, noLiveEvents } from "@doxahq/api/repositories/agent-live-events";
import { isAgentLiveActivityEnabled } from "@doxahq/contracts/agent-live-activity";
import type { AgentActor } from "@doxahq/api/services/agent-access/actor";
import { MembershipProjectAccessPolicy } from "@doxahq/api/services/agent-access/membership-project-access-policy";
import { AnalyticsOptOutCache } from "@doxahq/api/services/analytics/opt-out-cache";
import { createWorkerProductAnalytics } from "@doxahq/api/services/analytics/worker-product-analytics";
import type { OpenedRequestContext } from "./authenticated-request";
import { consoleMcpLogger } from "./logger";
import type { McpEnv } from "./mcp-env";
import { createRateLimiter } from "./rate-limit";
import { toServiceEnv } from "./service-env";
import { createMcpServices } from "./services/mcp-services";
import { createPlatformActions } from "./services/platform-actions";

/** Who turned product analytics off, kept for the life of the isolate. */
const ANALYTICS_OPT_OUTS = new AnalyticsOptOutCache();

/**
 * One database pool for the request (spec 10.5), shared by every service,
 * and one product analytics client. `close` runs in `waitUntil` after the
 * response body ends, also an SSE stream that a tool still writes after the
 * handler returns: it flushes analytics first, because the opt-out check
 * reads the request's database.
 */
export function openProductionContext(
  env: McpEnv,
  actor: AgentActor,
  waitUntil: (promise: Promise<unknown>) => void,
): OpenedRequestContext {
  const analytics = createWorkerProductAnalytics(env, { optOuts: ANALYTICS_OPT_OUTS });
  const scope = createRequestDbScope({
    ...toServiceEnv(env),
    ...(analytics.binding ? { PRODUCT_ANALYTICS: analytics.binding } : {}),
  });
  return {
    context: {
      requestId: crypto.randomUUID(),
      actor,
      policy: MembershipProjectAccessPolicy.fromEnv(scope.env),
      services: createMcpServices(scope.env, {
        uploadOrigin: new URL(env.MCP_RESOURCE_URL).origin,
      }),
      actions: createPlatformActions(env.PLATFORM_ACTIONS, actor),
      limiter: createRateLimiter({
        read: env.MCP_READ_LIMITER,
        write: env.MCP_WRITE_LIMITER,
        expensive: env.MCP_EXPENSIVE_LIMITER,
      }),
      activity: new AgentActivityRepository(scope.env),
      liveEvents: isAgentLiveActivityEnabled(env.AGENT_LIVE_ACTIVITY_ENABLED)
        ? new AgentLiveEventRepository(scope.env)
        : noLiveEvents,
      logger: consoleMcpLogger,
      waitUntil,
      now: () => Date.now(),
    },
    close: async () => {
      await analytics.flush();
      await scope.close();
    },
  };
}
