import { isAgentLiveActivityEnabled } from "@doxahq/contracts/agent-live-activity";
import type { Env } from "../env";
import { createApiRouter, type ApiApp, type ApiContext } from "../http/app";
import { withProjectAccess } from "../http/project-access";
import { asEventStreamResponse, streamEvents } from "../http/progress-stream";
import { error, json, notFound } from "../http/response";
import { AgentActivityService } from "../services/agent-live/agent-activity-service";
import {
  createStreamSlots,
  streamAgentActivity,
  type AgentActivityFeed,
} from "../services/agent-live/agent-activity-stream";
import { GrantsService } from "../services/oauth/grants-service";

/** How the routes get their services; tests pass fakes. */
export interface AgentActivityRouteServices {
  activity(env: Env): AgentActivityFeed & Pick<AgentActivityService, "diff">;
  grants(env: Env): Pick<GrantsService, "revokeByGrantRef">;
}

const servicesFromEnv: AgentActivityRouteServices = {
  activity: (env) => AgentActivityService.fromEnv(env),
  grants: (env) => GrantsService.fromEnv(env),
};

const NO_STORE = { headers: { "cache-control": "no-store" } };
const MAX_OPEN_STREAMS_PER_USER = 5;
const EVENT_SEQ_PATTERN = /^[1-9]\d{0,14}$/;

/** Mounted under `/projects/:projectId/agent-activity`. */
export function createAgentActivityRoutes(services = servicesFromEnv): ApiApp {
  const app = createApiRouter();
  const streamSlots = createStreamSlots(MAX_OPEN_STREAMS_PER_USER);

  app.get("/", (context) =>
    whenEnabled(context, () =>
      withProjectAccess(context, "docs.read", async (access) =>
        json(await services.activity(context.env).snapshot(access.projectId, access.actorUserId), NO_STORE),
      ),
    ),
  );

  app.get("/stream", (context) =>
    whenEnabled(context, () =>
      withProjectAccess(context, "docs.read", async (access) => {
        const release = streamSlots.acquire(access.actorUserId);
        if (release === null) return error("Too many open activity streams.", 429);
        const response = streamEvents(context, async (stream) => {
          // The loop can sleep for seconds, so the slot is freed as soon as the client leaves.
          stream.onAbort(release);
          try {
            await streamAgentActivity({
              stream,
              feed: services.activity(context.env),
              projectId: access.projectId,
              viewerUserId: access.actorUserId,
            });
          } catch (cause) {
            console.error("Agent activity stream failed.", cause instanceof Error ? cause.message : "Unknown error.");
          } finally {
            release();
          }
        });
        return asEventStreamResponse(context, response);
      }),
    ),
  );

  app.get("/:seq/diff", (context) =>
    whenEnabled(context, () =>
      withProjectAccess(context, "docs.read", async (access) => {
        const seq = context.req.param("seq");
        if (!EVENT_SEQ_PATTERN.test(seq)) return notFound();
        const diff = await services.activity(context.env).diff(access.projectId, Number(seq));
        return diff === null ? notFound() : json({ diff }, NO_STORE);
      }),
    ),
  );

  // Any reader can open the panel, but the revoke acts only on the caller's own grants.
  app.delete("/agents/:grantRef", (context) =>
    whenEnabled(context, () =>
      withProjectAccess(context, "docs.read", async (access) => {
        const revocation = await services
          .grants(context.env)
          .revokeByGrantRef(access.actorUserId, context.req.param("grantRef"));
        return revocation.kind === "revoked" ? json({ revoked: true }, NO_STORE) : notFound();
      }),
    ),
  );

  return app;
}

function whenEnabled(context: ApiContext, handler: () => Promise<Response>): Promise<Response> | Response {
  return isAgentLiveActivityEnabled(context.env.AGENT_LIVE_ACTIVITY_ENABLED) ? handler() : notFound();
}
