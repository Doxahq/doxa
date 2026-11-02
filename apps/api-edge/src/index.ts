import { BRIDGE_CALL_PATH_PREFIX, BRIDGE_FETCH_PATH_PREFIX, INTERNAL_PATH_PREFIX } from "@doxahq/api-bridge";
import { serveBridge } from "./bridge";
import type { EdgeEnv } from "./env";
import { sendCronTick } from "./origin";
import { proxyToOrigin } from "./proxy";
import { limitPublicRequest } from "./rate-limit";

export { AgentActionsApi, EmailDeliveryApi, InternalApi, OAuthTokenValidator, PrerenderTaskApi } from "./entrypoints";

/**
 * The thin doxa-api Worker. All API logic runs on the Node origin; this
 * Worker keeps what only a Worker can do:
 *
 *   - api.doxa.so: proxy every public request to the origin;
 *   - the RPC entrypoints that the other Workers bind to (see ./entrypoints);
 *   - the bridge that lets the origin use Queues and service bindings;
 *   - the 5-minute cron, sent to the origin as one request.
 */
export default {
  async fetch(request: Request, env: EdgeEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith(BRIDGE_CALL_PATH_PREFIX) || pathname.startsWith(BRIDGE_FETCH_PATH_PREFIX)) {
      return serveBridge(request, env);
    }
    // The origin's RPC and cron routes are for this Worker alone.
    if (pathname.startsWith(INTERNAL_PATH_PREFIX)) {
      return new Response("Not found.", { status: 404 });
    }
    const limited = await limitPublicRequest(request, env);
    if (limited) return limited;
    return proxyToOrigin(request, env);
  },

  async scheduled(event: ScheduledController, env: EdgeEnv, context: ExecutionContext): Promise<void> {
    context.waitUntil(sendCronTick(env, event.scheduledTime));
  },
} satisfies ExportedHandler<EdgeEnv>;
