import { Container, ContainerProxy } from "@cloudflare/containers";
import { createAgentContainerWorker, type WorkerEnv } from "./worker-core";
import { utilityGate } from "./utility/gate";
import { UTILITY_HOST, UTILITY_JOB_PORT } from "./utility/registry";

// Outbound interception of the agent container runs through this entrypoint.
export { ContainerProxy };

export class AgentContainer extends Container {
  defaultPort = 8789;
  sleepAfter = "2m";

  override async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    if (request.method === "POST" && pathname === "/admin/destroy") {
      await this.destroy();
      return Response.json({ ok: true });
    }

    return this.containerFetch(request);
  }
}

// Only `utility.internal` is intercepted; every other host keeps its normal
// internet access. The assignment goes through the setter, which fills the
// handler registry of the library; a static class field would skip it.
AgentContainer.outboundByHost = { [UTILITY_HOST]: utilityGate };

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
