import {
  AGENT_APPROVAL_DECISION_TOOL,
  AGENT_SESSION_GAP_MS,
  agentLiveEventKindSchema,
  agentPresence,
  type AgentActivitySnapshot,
  type AgentLiveAgent,
  type AgentLiveEvent,
} from "@doxahq/contracts/agent-live-activity";
import type { DbEnv } from "@doxahq/db";
import {
  AgentLiveEventRepository,
  type AgentLiveActivityReader,
  type AgentLiveEventRecord,
} from "../../repositories/agent-live-events";

/** Rows older than this are waiting for the purge, so readers skip them. */
export const AGENT_LIVE_EVENT_RETENTION_MS = 24 * 3600 * 1000;
const SNAPSHOT_EVENT_LIMIT = 100;
/** More than the snapshot shows: a busy agent can hide a quiet one in the newest rows. */
const AGENT_SUMMARY_EVENT_LIMIT = 300;

export interface AgentActivityServiceDependencies {
  reader: AgentLiveActivityReader;
  now: () => Date;
}

/** The live panel of the Content tab: who is working on a project, and on what. */
export class AgentActivityService {
  constructor(private readonly deps: AgentActivityServiceDependencies) {}

  static fromEnv(env: DbEnv): AgentActivityService {
    return new AgentActivityService({ reader: new AgentLiveEventRepository(env), now: () => new Date() });
  }

  async snapshot(projectId: string, viewerUserId: string): Promise<AgentActivitySnapshot> {
    const { records, agents, now } = await this.readAgents(projectId, viewerUserId);
    return {
      agents,
      events: records.slice(0, SNAPSHOT_EVENT_LIMIT).flatMap(toEvent),
      latestSeq: records[0]?.seq ?? 0,
      serverTime: now.toISOString(),
    };
  }

  async presence(
    projectId: string,
    viewerUserId: string,
  ): Promise<{ agents: AgentLiveAgent[]; serverTime: string }> {
    const { agents, now } = await this.readAgents(projectId, viewerUserId);
    return { agents, serverTime: now.toISOString() };
  }

  async eventsAfter(projectId: string, afterSeq: number, limit: number): Promise<AgentLiveEvent[]> {
    const records = await this.deps.reader.listAfter(projectId, afterSeq, this.retentionStart(), limit);
    return records.flatMap(toEvent);
  }

  diff(projectId: string, seq: number): Promise<string | null> {
    return this.deps.reader.findDiff(projectId, seq, this.retentionStart());
  }

  private async readAgents(projectId: string, viewerUserId: string) {
    const now = this.deps.now();
    const [records, pending] = await Promise.all([
      this.deps.reader.listRecent(projectId, this.retentionStart(), AGENT_SUMMARY_EVENT_LIMIT),
      this.deps.reader.pendingApprovalGrantRefs(projectId),
    ]);
    const tokenNames = await this.deps.reader.tokenNamesByGrantRef([
      ...new Set(records.map((record) => record.grantRef)),
    ]);
    return { records, now, agents: summarizeAgents(records, { pending, tokenNames, viewerUserId, now }) };
  }

  private retentionStart(): Date {
    return new Date(this.deps.now().getTime() - AGENT_LIVE_EVENT_RETENTION_MS);
  }
}

interface SummaryContext {
  readonly pending: ReadonlySet<string>;
  readonly tokenNames: ReadonlyMap<string, string>;
  readonly viewerUserId: string;
  readonly now: Date;
}

/** Pure. `records` are newest first. An agent is one grant on this project. */
export function summarizeAgents(
  records: readonly AgentLiveEventRecord[],
  context: SummaryContext,
): AgentLiveAgent[] {
  const byGrant = new Map<string, AgentLiveEventRecord[]>();
  for (const record of records) {
    byGrant.set(record.grantRef, [...(byGrant.get(record.grantRef) ?? []), record]);
  }
  return [...byGrant.values()].flatMap((allEvents) => {
    // A person's decision is in the feed, but it does not mean that the agent is active.
    const events = allEvents.filter((event) => event.tool !== AGENT_APPROVAL_DECISION_TOOL);
    const newest = events[0];
    if (newest === undefined) return [];
    const presence = agentPresence({
      lastEventAt: newest.occurredAt,
      hasPendingApproval: context.pending.has(newest.grantRef),
      now: context.now,
    });
    if (presence === null) return [];
    return [
      {
        grantRef: newest.grantRef,
        clientName: newest.clientName,
        tokenName: context.tokenNames.get(newest.grantRef) ?? null,
        presence,
        startedAt: sessionStart(events).toISOString(),
        lastEventAt: newest.occurredAt.toISOString(),
        canRevoke: newest.userId === context.viewerUserId,
      },
    ];
  });
}

/** The oldest event before the first long gap. */
function sessionStart(newestFirst: readonly AgentLiveEventRecord[]): Date {
  let start = newestFirst[0]?.occurredAt ?? new Date(0);
  for (const event of newestFirst.slice(1)) {
    if (start.getTime() - event.occurredAt.getTime() > AGENT_SESSION_GAP_MS) break;
    start = event.occurredAt;
  }
  return start;
}

/** Empty for a kind that this build does not know, so that one row cannot break the panel. */
function toEvent(record: AgentLiveEventRecord): AgentLiveEvent[] {
  const kind = agentLiveEventKindSchema.safeParse(record.kind);
  if (!kind.success) return [];
  return [
    {
      seq: record.seq,
      occurredAt: record.occurredAt.toISOString(),
      branchId: record.branchId,
      grantRef: record.grantRef,
      clientName: record.clientName,
      tool: record.tool,
      kind: kind.data,
      pageHref: record.pageHref,
      pageTitle: record.pageTitle,
      detail: record.detail,
      note: record.note,
      linesAdded: record.linesAdded,
      linesRemoved: record.linesRemoved,
      branchRevision: record.branchRevision,
      hasDiff: record.hasDiff,
    },
  ];
}
