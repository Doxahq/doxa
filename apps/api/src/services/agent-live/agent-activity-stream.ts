import type { AgentActivityStreamMessage } from "@doxahq/contracts/agent-live-activity";
import type { AgentActivityService } from "./agent-activity-service";

export type AgentActivityFeed = Pick<AgentActivityService, "snapshot" | "presence" | "eventsAfter">;

/** The part of the SSE stream that the loop needs. */
export interface ActivityStreamWriter {
  readonly aborted: boolean;
  writeSSE(message: { event: string; data: string; id?: string }): Promise<void>;
  sleep(ms: number): Promise<unknown>;
}

const ACTIVE_POLL_MS = 1_000;
const QUIET_POLL_MS = 5_000;
const ACTIVE_WINDOW_MS = 2 * 60_000;
/** Keeps the tunnel open, and tells the panel when an agent turns idle. */
const PRESENCE_INTERVAL_MS = 15_000;
/** Each reconnect checks project access again, so this bounds a removed member's view. */
export const MAX_STREAM_DURATION_MS = 5 * 60_000;
const EVENT_BATCH_SIZE = 100;

function send(stream: ActivityStreamWriter, message: AgentActivityStreamMessage, id?: number): Promise<void> {
  return stream.writeSSE({
    event: message.type,
    data: JSON.stringify(message),
    ...(id === undefined ? {} : { id: String(id) }),
  });
}

/**
 * Sends a snapshot, then each new event in order. Postgres holds the events,
 * so this works across ECS tasks, and a poll holds no connection between runs.
 */
export async function streamAgentActivity(input: {
  stream: ActivityStreamWriter;
  feed: AgentActivityFeed;
  projectId: string;
  viewerUserId: string;
  now?: () => number;
}): Promise<void> {
  const { stream, feed, projectId, viewerUserId } = input;
  const now = input.now ?? Date.now;
  const startedAt = now();
  const snapshot = await feed.snapshot(projectId, viewerUserId);
  await send(stream, { type: "snapshot", snapshot });

  let seq = snapshot.latestSeq;
  const newest = snapshot.events[0];
  let lastEventAt = newest === undefined ? 0 : Date.parse(newest.occurredAt);
  let lastPresenceAt = now();

  while (!stream.aborted && now() - startedAt < MAX_STREAM_DURATION_MS) {
    const events = await feed.eventsAfter(projectId, seq, EVENT_BATCH_SIZE);
    for (const event of events) {
      seq = event.seq;
      lastEventAt = now();
      await send(stream, { type: "event", event }, event.seq);
    }

    if (events.length > 0 || now() - lastPresenceAt >= PRESENCE_INTERVAL_MS) {
      await send(stream, { type: "presence", ...(await feed.presence(projectId, viewerUserId)) });
      lastPresenceAt = now();
    }

    if (events.length === EVENT_BATCH_SIZE) continue;
    await stream.sleep(now() - lastEventAt < ACTIVE_WINDOW_MS ? ACTIVE_POLL_MS : QUIET_POLL_MS);
  }
}

/** Limits open streams per user, on this process. Returns null at the limit. */
export function createStreamSlots(maxPerUser: number) {
  const open = new Map<string, number>();
  return {
    acquire(userId: string): (() => void) | null {
      const count = open.get(userId) ?? 0;
      if (count >= maxPerUser) return null;
      open.set(userId, count + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (open.get(userId) ?? 1) - 1;
        if (remaining === 0) open.delete(userId);
        else open.set(userId, remaining);
      };
    },
  };
}
