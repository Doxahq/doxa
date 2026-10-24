import { createApiRequestHandler } from "./app";
import type { Env } from "./env";
import { runScheduledJobs } from "./scheduled";
import { AgentActionsApi } from "./services/agent-actions/rpc";
import { EmailDeliveryApi } from "./services/email/email-delivery-api";
import { InternalApi } from "./services/internal-api";
import { OAuthTokenValidator } from "./services/oauth/token-validator";
import { PrerenderTaskApi } from "./services/prerender-task-api";

export { AgentActionsApi, EmailDeliveryApi, InternalApi, OAuthTokenValidator, PrerenderTaskApi };

export default {
  fetch: createApiRequestHandler(),
  async scheduled(event: ScheduledEvent, env: Env, context: ExecutionContext): Promise<void> {
    runScheduledJobs(event.scheduledTime, env, context);
  },
};
