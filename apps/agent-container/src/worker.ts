import { Container, ContainerProxy } from "@cloudflare/containers";
import { createAgentContainerWorker, type WorkerEnv } from "./worker-core";
import { agentEgressContainerSettings, agentEgressGate, type AgentEgressEnv } from "./egress";
import { utilityGate } from "./utility/gate";
import { UTILITY_HOST, UTILITY_JOB_PORT } from "./utility/registry";

// Outbound interception of the agent container runs through this entrypoint.
export { ContainerProxy };

export class AgentContainer extends Container<AgentEgressEnv> {
  defaultPort = 8789;
  sleepAfter = "2m";
  /** `AGENT_EGRESS_MODE` decides these; see `src/egress.ts`. */
  private readonly egress = agentEgressContainerSettings(this.env);
  /** In `enforce` mode, only requests that the egress gate forwards leave the container. */
  override enableInternet = this.egress.enableInternet;
  /** HTTPS reaches the egress gate too, except in `off` mode. */
  override interceptHttps = this.egress.interceptHttps;

  override async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    if (request.method === "POST" && pathname === "/admin/destroy") {
      await this.destroy();
      return Response.json({ ok: true });
    }

    return this.containerFetch(request);
  }
}

// `utility.internal` goes to the utility gate. Every other HTTP and HTTPS
// request goes to the egress gate, which logs it and, in `enforce` mode,
// refuses hosts that are not on the allow list. The assignments go through
// the setters, which fill the handler registry of the library; static class
// fields would skip it.
AgentContainer.outboundByHost = { [UTILITY_HOST]: utilityGate };
AgentContainer.outbound = agentEgressGate;

/**
 * What every utility job container shares: no internet and an empty
 * environment, so no keys or tokens. Each job has its own image.
 */
abstract class UtilityContainer extends Container {
  defaultPort = UTILITY_JOB_PORT;
  /** A backstop; the gate destroys the instance after the last call of its run. */
  sleepAfter = "30s";
  enableInternet = false;
  envVars = {};
}

/** The spec-reader job: OpenAPI and Swagger files in, spec facts out. */
export class SpecReaderJob extends UtilityContainer {}

export default createAgentContainerWorker() satisfies ExportedHandler<WorkerEnv>;
