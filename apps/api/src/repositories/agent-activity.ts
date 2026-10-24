import { createDb, schema, type DbEnv } from "@doxahq/db";
import type { ApprovalSettingChange } from "../services/agent-actions/setting-activity";

export type AgentActivityOutcome =
  (typeof schema.agentActivityOutcome.enumValues)[number];

export interface AgentActivityRecord {
  userId: string;
  clientId: string;
  clientName: string;
  grantRef: string;
  projectId: string | null;
  tool: string;
  actionKind: string | null;
  approvalRequestId: string | null;
  outcome: AgentActivityOutcome;
  errorCode: string | null;
  policySource: string | null;
  durationMs: number;
  /** A hash of the input. Never the content. */
  inputSha256: string | null;
  /** Small structured facts, such as the old and the new mode of a setting. */
  details?: ApprovalSettingChange;
}

/** Append only: no code updates or deletes a row, except the retention cron. */
export interface AgentActivityStore {
  append(record: AgentActivityRecord): Promise<void>;
}

export class AgentActivityRepository implements AgentActivityStore {
  private readonly db;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  async append(record: AgentActivityRecord): Promise<void> {
    await this.db.insert(schema.agentActivity).values(record);
  }
}
