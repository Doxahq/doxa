import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../../env";
import { createAgentActionRuntime } from "./action-runtime";
import { AgentActionsRpcHandler } from "./rpc-handler";
import type { AgentActionsRpc } from "./rpc-contract";

/** The service binding that doxa-mcp calls for consequential actions (spec 5.2). */
export class AgentActionsApi extends WorkerEntrypoint<Env> implements AgentActionsRpc {
  perform(input: unknown) {
    return this.handler().perform(input);
  }

  getRequest(input: unknown) {
    return this.handler().getRequest(input);
  }

  getRequestTask(input: unknown) {
    return this.handler().getRequestTask(input);
  }

  listRequests(input: unknown) {
    return this.handler().listRequests(input);
  }

  cancelRequest(input: unknown) {
    return this.handler().cancelRequest(input);
  }

  private handler(): AgentActionsRpcHandler {
    const runtime = createAgentActionRuntime(this.env, {
      defer: (work) => this.ctx.waitUntil(work),
    });
    return new AgentActionsRpcHandler(runtime);
  }
}
