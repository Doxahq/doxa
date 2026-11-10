import { and, eq, inArray, max } from "drizzle-orm";
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

export interface AgentActivityReadOptions {
  /** Off while the live activity is off, so that a read needs only the audit table. */
  readonly includeLiveEvents: boolean;
}

export class AgentActivityRepository implements AgentActivityStore {
  private readonly db;

  constructor(
    env: DbEnv,
    private readonly readOptions: AgentActivityReadOptions = { includeLiveEvents: false },
  ) {
    this.db = createDb(env);
  }

  async append(record: AgentActivityRecord): Promise<void> {
    await this.db.insert(schema.agentActivity).values(record);
  }

  /** The audit table has no reads, so the 24-hour live events fill that gap. */
  async lastActivityByGrantRef(
    userId: string,
    grantRefs: readonly string[],
  ): Promise<ReadonlyMap<string, Date>> {
    if (grantRefs.length === 0) return new Map();
    const refs = [...grantRefs];
    const [audited, live] = await Promise.all([
      this.lastAuditedActivity(userId, refs),
      this.readOptions.includeLiveEvents ? this.lastLiveActivity(userId, refs) : [],
    ]);
    const latest = new Map<string, Date>();
    for (const { grantRef, last } of [...audited, ...live]) {
      const known = latest.get(grantRef);
      if (last !== null && (known === undefined || last > known)) latest.set(grantRef, last);
    }
    return latest;
  }

  private lastAuditedActivity(userId: string, grantRefs: string[]) {
    const { agentActivity } = schema;
    return this.db
      .select({ grantRef: agentActivity.grantRef, last: max(agentActivity.occurredAt) })
      .from(agentActivity)
      .where(and(eq(agentActivity.userId, userId), inArray(agentActivity.grantRef, grantRefs)))
      .groupBy(agentActivity.grantRef);
  }

  private lastLiveActivity(userId: string, grantRefs: string[]) {
    const { agentLiveEvents } = schema;
    return this.db
      .select({ grantRef: agentLiveEvents.grantRef, last: max(agentLiveEvents.occurredAt) })
      .from(agentLiveEvents)
      .where(and(eq(agentLiveEvents.userId, userId), inArray(agentLiveEvents.grantRef, grantRefs)))
      .groupBy(agentLiveEvents.grantRef);
  }
}
