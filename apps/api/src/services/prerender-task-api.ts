import type {
  PrerenderRepairRequest,
  PrerenderTaskApiRpc,
} from "@doxahq/contracts/docs-prerender-tasks";
import { WorkerEntrypoint } from "cloudflare:workers";

import type { Env } from "../env";
import { DocsPrerenderTasksRepository } from "../repositories/docs-prerender-tasks";
import { DocsPrerenderTaskMaintenance } from "./docs-prerender-tasks";

/** Private RPC entrypoint used by the pre-render Workflow and dispatcher. */
export class PrerenderTaskApi
  extends WorkerEntrypoint<Env>
  implements PrerenderTaskApiRpc
{
  private repository(): DocsPrerenderTasksRepository {
    return new DocsPrerenderTasksRepository(this.env);
  }

  validate(input: Parameters<PrerenderTaskApiRpc["validate"]>[0]) {
    return this.repository().validate(input);
  }

  heartbeat(input: Parameters<PrerenderTaskApiRpc["heartbeat"]>[0]) {
    return this.repository().heartbeat(input);
  }

  complete(input: Parameters<PrerenderTaskApiRpc["complete"]>[0]) {
    return this.repository().complete(input);
  }

  fail(input: Parameters<PrerenderTaskApiRpc["fail"]>[0]) {
    return this.repository().fail(input);
  }

  async enqueueRepair(input: PrerenderRepairRequest) {
    const repository = this.repository();
    const result = await repository.enqueueRepair(input);
    if (result.status === "accepted" && result.taskId) {
      await new DocsPrerenderTaskMaintenance(
        repository,
        this.env.PRERENDER_QUEUE,
      )
        .dispatch([result.taskId])
        .catch(() => undefined);
    }
    return result;
  }
}
