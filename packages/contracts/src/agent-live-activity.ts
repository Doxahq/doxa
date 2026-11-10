import { z } from "zod";

export const AGENT_LIVE_EVENT_KINDS = [
  "read",
  "search",
  "edit",
  "branch",
  "preview",
  "publish",
  "generation",
  "domain",
  "approval",
] as const;

export const agentLiveEventKindSchema = z.enum(AGENT_LIVE_EVENT_KINDS);
export type AgentLiveEventKind = z.infer<typeof agentLiveEventKindSchema>;

/** Text that an agent chose. The longest value that Doxa stores or shows. */
export const AGENT_LIVE_TEXT_MAX_LENGTH = 200;
/**
 * An agent with an event newer than this is active. MCP has no "finished"
 * signal, so this is how long the status stays on after the last tool call.
 */
export const AGENT_ACTIVE_WINDOW_MS = 60_000;
/** An agent with an event older than this is not listed, and a new session starts. */
export const AGENT_SESSION_GAP_MS = 30 * 60_000;

export const agentPresenceSchema = z.enum(["waiting", "active", "idle"]);
export type AgentPresence = z.infer<typeof agentPresenceSchema>;

export const agentLiveEventSchema = z
  .object({
    seq: z.number().int().positive(),
    occurredAt: z.iso.datetime(),
    branchId: z.uuid().nullable(),
    grantRef: z.string(),
    clientName: z.string(),
    tool: z.string(),
    kind: agentLiveEventKindSchema,
    pageHref: z.string().nullable(),
    pageTitle: z.string().nullable(),
    detail: z.string().nullable(),
    note: z.string().nullable(),
    linesAdded: z.number().int().nonnegative().nullable(),
    linesRemoved: z.number().int().nonnegative().nullable(),
    branchRevision: z.number().int().nonnegative().nullable(),
    hasDiff: z.boolean(),
  })
  .strict();
export type AgentLiveEvent = z.infer<typeof agentLiveEventSchema>;

export const agentLiveAgentSchema = z
  .object({
    grantRef: z.string(),
    clientName: z.string(),
    /** The label that the person approved. Null for an OAuth client. */
    tokenName: z.string().nullable(),
    presence: agentPresenceSchema,
    startedAt: z.iso.datetime(),
    lastEventAt: z.iso.datetime(),
    /** True only for the member who connected this agent. */
    canRevoke: z.boolean(),
  })
  .strict();
export type AgentLiveAgent = z.infer<typeof agentLiveAgentSchema>;

export const agentActivitySnapshotSchema = z
  .object({
    agents: z.array(agentLiveAgentSchema),
    /** Newest first. */
    events: z.array(agentLiveEventSchema),
    latestSeq: z.number().int().nonnegative(),
    serverTime: z.iso.datetime(),
  })
  .strict();
export type AgentActivitySnapshot = z.infer<typeof agentActivitySnapshotSchema>;

/** A stream starts with a snapshot, so a reconnect needs no position from the client. */
export const agentActivityStreamMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), snapshot: agentActivitySnapshotSchema }).strict(),
  z.object({ type: z.literal("event"), event: agentLiveEventSchema }).strict(),
  z
    .object({
      type: z.literal("presence"),
      agents: z.array(agentLiveAgentSchema),
      serverTime: z.iso.datetime(),
    })
    .strict(),
]);
export type AgentActivityStreamMessage = z.infer<typeof agentActivityStreamMessageSchema>;

export const agentActivityDiffSchema = z.object({ diff: z.string() }).strict();
export type AgentActivityDiff = z.infer<typeof agentActivityDiffSchema>;

/** The tool name of an event that a person caused by deciding an approval. */
export const AGENT_APPROVAL_DECISION_TOOL = "approval_decision";

/** The switch fails closed: only the exact value `true` turns the feature on. */
export function isAgentLiveActivityEnabled(value: string | undefined): boolean {
  return value?.trim() === "true";
}

// The bidirectional controls can make text read differently from what it stores.
const BIDIRECTIONAL_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/gu;
const CONTROL_CHARACTERS = /\p{Cc}+/gu;
const SPACES = /\s+/gu;

/** Agent-written text as one safe line. Null when nothing readable is left. */
export function cleanAgentText(
  value: string | null | undefined,
  maxLength = AGENT_LIVE_TEXT_MAX_LENGTH,
): string | null {
  if (value === null || value === undefined) return null;
  const line = value
    .replace(BIDIRECTIONAL_CONTROLS, "")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(SPACES, " ")
    .trim();
  if (line.length === 0) return null;
  return [...line].slice(0, maxLength).join("");
}

/** Null means that the agent is no longer listed. A pending approval always counts. */
export function agentPresence(input: {
  lastEventAt: Date;
  hasPendingApproval: boolean;
  now: Date;
}): AgentPresence | null {
  if (input.hasPendingApproval) return "waiting";
  const age = input.now.getTime() - input.lastEventAt.getTime();
  if (age < AGENT_ACTIVE_WINDOW_MS) return "active";
  return age <= AGENT_SESSION_GAP_MS ? "idle" : null;
}
