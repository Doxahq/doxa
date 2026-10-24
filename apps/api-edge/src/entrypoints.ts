import { WorkerEntrypoint } from "cloudflare:workers";
import { API_ENTRYPOINT_METHODS, type ApiEntrypointName } from "@doxahq/api-bridge";
import type { EdgeEnv } from "./env";
import { callOrigin } from "./origin";

/**
 * An RPC entrypoint with the name and methods of the API's entrypoint, whose
 * methods forward each call to the origin. Workers RPC calls methods of the
 * class prototype, so the forwarders go on the prototype, and nothing else
 * does: every prototype method can be called by the caller Workers.
 */
function createForwardingEntrypoint(entrypoint: ApiEntrypointName): typeof WorkerEntrypoint<EdgeEnv> {
  class ForwardingEntrypoint extends WorkerEntrypoint<EdgeEnv> {
    static {
      for (const method of API_ENTRYPOINT_METHODS[entrypoint]) {
        Object.defineProperty(this.prototype, method, {
          value: function forward(this: ForwardingEntrypoint, ...args: unknown[]) {
            return callOrigin(this.env, entrypoint, method, args);
          },
          writable: true,
          configurable: true,
        });
      }
    }
  }

  Object.defineProperty(ForwardingEntrypoint, "name", { value: entrypoint });
  return ForwardingEntrypoint;
}

export const InternalApi = createForwardingEntrypoint("InternalApi");
export const PrerenderTaskApi = createForwardingEntrypoint("PrerenderTaskApi");
export const OAuthTokenValidator = createForwardingEntrypoint("OAuthTokenValidator");
export const AgentActionsApi = createForwardingEntrypoint("AgentActionsApi");
export const EmailDeliveryApi = createForwardingEntrypoint("EmailDeliveryApi");
