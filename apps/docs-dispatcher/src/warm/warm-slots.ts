import { z } from "zod";

/**
 * The global cap on regional warmers that fill at the same time (F9), and a
 * per-site cap inside it, so one site cannot hold most slots (FS-L1). A
 * warmer holds a slot for one alarm run; a lease that its holder never
 * released ends by itself, so a crashed warmer cannot keep a slot. Expiry is
 * checked lazily, on every call. Pure functions over the stored state.
 */
const leaseSchema = z
  .object({
    /** Lease end (epoch ms). */
    until: z.number().int(),
    siteId: z.string().min(1).max(128),
  })
  .strict();

export const slotStateSchema = z
  .object({
    /** Holder name → its lease. */
    leases: z.record(z.string().min(1).max(300), leaseSchema),
  })
  .strict();

export type SlotState = z.infer<typeof slotStateSchema>;
type Lease = z.infer<typeof leaseSchema>;

export const EMPTY_SLOT_STATE: SlotState = { leases: {} };

/** A warmer alarm runs at most ≈ 12 minutes; the lease adds a margin. */
export const SLOT_LEASE_MS = 15 * 60_000;

export interface SlotRequest {
  holder: string;
  siteId: string;
  /** `DOXA_WARM_MAX_ACTIVE_WARMERS` as the caller read it. */
  max: number;
  /** `DOXA_WARM_MAX_ACTIVE_WARMERS_PER_SITE` as the caller read it. */
  maxPerSite: number;
  now: number;
  leaseMs?: number;
}

export type SlotDenial = "global_cap" | "site_cap";

export interface SlotDecision {
  state: SlotState;
  granted: boolean;
  /** Why a request was denied; null when it was granted. */
  denied: SlotDenial | null;
  /** Leases held after the decision. */
  active: number;
  /** Leases that had ended and were dropped. */
  expired: number;
}

/**
 * Grants or renews a lease; never more than `max` holders at once, nor more
 * than `maxPerSite` holders of one site.
 */
export function acquireSlot(state: SlotState, request: SlotRequest): SlotDecision {
  const { leases, expired } = withoutExpired(state.leases, request.now);
  const active = Object.keys(leases).length;
  const denied = Object.hasOwn(leases, request.holder) ? null : denialOf(leases, request);
  if (denied) {
    return { state: { leases }, granted: false, denied, active, expired };
  }
  const lease: Lease = {
    until: request.now + (request.leaseMs ?? SLOT_LEASE_MS),
    siteId: request.siteId,
  };
  const next = { ...leases, [request.holder]: lease };
  return {
    state: { leases: next },
    granted: true,
    denied: null,
    active: Object.keys(next).length,
    expired,
  };
}

function denialOf(
  leases: Readonly<Record<string, Lease>>,
  request: SlotRequest,
): SlotDenial | null {
  const all = Object.values(leases);
  if (all.length >= request.max) return "global_cap";
  const ofSite = all.filter((lease) => lease.siteId === request.siteId).length;
  return ofSite >= request.maxPerSite ? "site_cap" : null;
}

/** Frees the holder's slot. Returns `state` itself when nothing changes. */
export function releaseSlot(
  state: SlotState,
  holder: string,
  now: number,
): SlotState {
  const { leases, expired } = withoutExpired(state.leases, now);
  if (!Object.hasOwn(leases, holder) && expired === 0) return state;
  const { [holder]: _released, ...rest } = leases;
  return { leases: rest };
}

/** How many more holders `max` allows now. */
export function freeSlots(state: SlotState, max: number, now: number): number {
  const { leases } = withoutExpired(state.leases, now);
  return Math.max(0, max - Object.keys(leases).length);
}

export function parseSlotState(value: unknown): SlotState | null {
  const parsed = slotStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function withoutExpired(
  leases: Readonly<Record<string, Lease>>,
  now: number,
): { leases: Record<string, Lease>; expired: number } {
  const live = Object.entries(leases).filter(([, lease]) => lease.until > now);
  return {
    leases: Object.fromEntries(live),
    expired: Object.keys(leases).length - live.length,
  };
}

/** One denial log line per this many denials (FC-L10). */
export const DENIAL_LOG_SAMPLE = 20;

/**
 * Counts denials and says when one should be logged: the first, then every
 * `DENIAL_LOG_SAMPLE`-th. Grants, releases and expiries are always logged.
 */
export class DenialSampler {
  private count = 0;

  /** Returns the denial count to log, or null to skip this one. */
  record(): number | null {
    this.count += 1;
    return this.count % DENIAL_LOG_SAMPLE === 1 ? this.count : null;
  }
}
