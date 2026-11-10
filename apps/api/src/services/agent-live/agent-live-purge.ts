import type { DbEnv } from "@doxahq/db";
import { AgentLiveEventRepository } from "../../repositories/agent-live-events";
import { AGENT_LIVE_EVENT_RETENTION_MS } from "./agent-activity-service";

/** Cron cleanup. It runs with the feature off too, so old diffs always expire. */
export async function purgeAgentLiveEvents(env: DbEnv, now = new Date()): Promise<void> {
  await new AgentLiveEventRepository(env).deleteExpired(
    new Date(now.getTime() - AGENT_LIVE_EVENT_RETENTION_MS),
  );
}
