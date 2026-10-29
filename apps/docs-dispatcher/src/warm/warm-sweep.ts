import { docsHostnameMapEntrySchema } from "@doxahq/contracts/docs-hostname-map";
import {
  DOCS_WARM_MESSAGE_HOSTNAME_LIMIT,
  type DocsWarmMessage,
} from "@doxahq/contracts/docs-warm-job";
import { z } from "zod";

/**
 * The renderer-deploy sweep (M28): on each cron tick, list the hostname map
 * from a stored cursor, group the keys by site and enqueue at most `cap`
 * sites to the sweep queue. A new release resets the cursor; a finished
 * list stays done until the next release. Idempotent: the state is saved
 * only after the messages were sent, and the site lock drops duplicates.
 */

const HOST_PREFIX = "host:";
const LIST_LIMIT = 1_000;
/** Pages read per tick at most, so one tick stays short. */
const MAX_PAGES_PER_TICK = 5;
const SEND_BATCH_LIMIT = 100;

export const sweepStateSchema = z
  .object({
    releaseId: z.string().regex(/^[a-f0-9]{64}$/),
    /** The list cursor of the current page; null for the first page. */
    cursor: z.string().min(1).nullable(),
    /** Keys of the current page that earlier ticks already took. */
    offset: z.number().int().nonnegative(),
    done: z.boolean(),
    enqueued: z.number().int().nonnegative(),
    startedAt: z.number().int().nonnegative(),
  })
  .strict();

export type SweepState = z.infer<typeof sweepStateSchema>;

export function parseSweepState(value: unknown): SweepState | null {
  const parsed = sweepStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface SweepListKey {
  name: string;
  metadata?: unknown;
}

export interface SweepListPage {
  keys: SweepListKey[];
  list_complete: boolean;
  cursor?: string;
}

export interface SweepDeps {
  list(options: { prefix: string; cursor?: string; limit: number }): Promise<SweepListPage>;
  get(key: string): Promise<string | null>;
  send(messages: DocsWarmMessage[]): Promise<void>;
  isWarmSite(siteId: string): boolean;
  createJobId(): string;
  now(): number;
}

export interface SweepTickResult {
  state: SweepState;
  reset: boolean;
  enqueued: number;
  pages: number;
}

/**
 * Sites one tick may enqueue: every site starts a warmer per pool, so a
 * tick never starts more warmers than there are free slots (FC-H2).
 */
export function sweepSiteCap(input: {
  sitesPerTick: number;
  freeSlots: number;
  pools: number;
}): number {
  const perSite = Math.max(1, input.pools);
  return Math.max(0, Math.min(input.sitesPerTick, Math.floor(input.freeSlots / perSite)));
}

export async function runSweepTick(
  stored: SweepState | null,
  input: { releaseId: string; cap: number },
  deps: SweepDeps,
): Promise<SweepTickResult> {
  const reset = !stored || stored.releaseId !== input.releaseId;
  let state: SweepState =
    stored && !reset
      ? stored
      : {
          releaseId: input.releaseId,
          cursor: null,
          offset: 0,
          done: false,
          enqueued: 0,
          startedAt: deps.now(),
        };
  if (state.done || input.cap <= 0) return { state, reset, enqueued: 0, pages: 0 };

  const sites = new Map<string, string[]>();
  let pages = 0;
  scan: while (pages < MAX_PAGES_PER_TICK) {
    const page = await deps.list({
      prefix: HOST_PREFIX,
      limit: LIST_LIMIT,
      ...(state.cursor ? { cursor: state.cursor } : {}),
    });
    pages += 1;
    const keys = page.keys.slice(state.offset);
    for (const [index, key] of keys.entries()) {
      const siteId = await siteIdOf(key, deps);
      if (!siteId || !deps.isWarmSite(siteId)) continue;
      const hostnames = sites.get(siteId);
      if (!hostnames && sites.size >= input.cap) {
        state = { ...state, offset: state.offset + index };
        break scan;
      }
      const list = hostnames ?? [];
      if (list.length < DOCS_WARM_MESSAGE_HOSTNAME_LIMIT) {
        list.push(key.name.slice(HOST_PREFIX.length));
      }
      sites.set(siteId, list);
    }
    if (page.list_complete || !page.cursor) {
      state = { ...state, cursor: null, offset: 0, done: true };
      break;
    }
    state = { ...state, cursor: page.cursor, offset: 0 };
  }

  const messages = [...sites].map(
    ([siteId, hostnames]): DocsWarmMessage => ({
      v: 1,
      reason: "deploy",
      siteId,
      hostnames,
      releaseId: input.releaseId,
      jobId: deps.createJobId(),
      enqueuedAt: deps.now(),
    }),
  );
  for (let start = 0; start < messages.length; start += SEND_BATCH_LIMIT) {
    await deps.send(messages.slice(start, start + SEND_BATCH_LIMIT));
  }
  return {
    state: { ...state, enqueued: state.enqueued + messages.length },
    reset,
    enqueued: messages.length,
    pages,
  };
}

/** `metadata.siteId` (F26), else the stored entry's site. */
async function siteIdOf(key: SweepListKey, deps: Pick<SweepDeps, "get">): Promise<string | null> {
  const metadata = z.object({ siteId: z.string().min(1) }).safeParse(key.metadata);
  if (metadata.success) return metadata.data.siteId;
  const text = await deps.get(key.name);
  if (text === null) return null;
  try {
    const entry = docsHostnameMapEntrySchema.safeParse(JSON.parse(text));
    return entry.success ? entry.data.resolution.siteId : null;
  } catch {
    return null;
  }
}
