import {
  ORIGIN_KEY_HEADER,
  RPC_PATH_PREFIX,
  isApiEntrypointMethod,
  isApiEntrypointName,
  parseCallPath,
  serveRemoteCall,
  type ApiEntrypointName,
} from "@doxahq/api-bridge";
import type { Env } from "../../env";
import { AgentActionsApi } from "../../services/agent-actions/rpc";
import { EmailDeliveryApi } from "../../services/email/email-delivery-api";
import { InternalApi } from "../../services/internal-api";
import { OAuthTokenValidator } from "../../services/oauth/token-validator";
import { PrerenderTaskApi } from "../../services/prerender-task-api";

export type EntrypointClass = new (ctx: ExecutionContext, env: Env) => object;
export type EntrypointClasses = Record<ApiEntrypointName, EntrypointClass>;

/** The classes that the Worker exports as RPC entrypoints, by export name. */
export const API_ENTRYPOINTS = {
  InternalApi,
  PrerenderTaskApi,
  OAuthTokenValidator,
  AgentActionsApi,
  EmailDeliveryApi,
} satisfies EntrypointClasses;

export interface RpcHandlerDeps {
  env: Env;
  originKey: string;
  createExecutionContext(): ExecutionContext;
  /** The classes to call. Tests pass their own. */
  entrypoints?: EntrypointClasses;
}

/**
 * Serves `POST /__rpc/:entrypoint/:method`: the edge Worker's forward of one
 * service-binding call. The method runs on a new instance of the entrypoint
 * class, as workerd runs each RPC call.
 */
export function createRpcHandler(deps: RpcHandlerDeps): (request: Request) => Promise<Response> {
  const entrypoints = deps.entrypoints ?? API_ENTRYPOINTS;
  return async (request) => {
    const call = parseCallPath(new URL(request.url).pathname, RPC_PATH_PREFIX);
    if (!call || !isApiEntrypointName(call.target) || !isApiEntrypointMethod(call.target, call.method)) {
      return new Response("Unknown RPC method.", { status: 404 });
    }
    const entrypoint = call.target;
    const method = call.method;

    return serveRemoteCall(request, { keyHeader: ORIGIN_KEY_HEADER, key: deps.originKey }, (args) => {
      const instance = new entrypoints[entrypoint](deps.createExecutionContext(), deps.env);
      const target: unknown = Reflect.get(instance, method);
      if (typeof target !== "function") {
        throw new Error(`${entrypoint}.${method} is not a method.`);
      }
      return Reflect.apply(target, instance, args);
    });
  };
}
