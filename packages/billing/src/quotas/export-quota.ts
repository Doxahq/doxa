import { isUnlimited } from "../catalog/define";
import { HOUR_MS, type Clock } from "../clock";
import type { Entitlements } from "../entitlements/resolve";
import type { BillingStore } from "../store/store";

/** The limit that sets the window length. */
export const EXPORT_WINDOW_LIMIT_KEY = "docs.export_window_hours";

/** Exports in one window, for each billing account. */
export const EXPORTS_PER_WINDOW = 1;

export type ExportQuotaStatus =
  | { readonly unlimited: true; readonly available: true }
  | {
      readonly unlimited: false;
      readonly available: boolean;
      readonly windowHours: number;
      /** The time of the last export, or null for none. */
      readonly lastExportAt: Date | null;
      /** When the next export opens: the last export plus the window. Null while it is open. */
      readonly resetsAt: Date | null;
    };

export type ExportQuotaReservation =
  | { readonly allowed: true; readonly unlimited: true; release(): Promise<void> }
  | {
      readonly allowed: true;
      readonly unlimited: false;
      readonly windowHours: number;
      /** The next export opens at this time. */
      readonly resetsAt: Date;
      /** Gives the export back, at most once. */
      release(): Promise<void>;
    }
  | {
      readonly allowed: false;
      readonly unlimited: false;
      readonly windowHours: number;
      readonly resetsAt: Date;
    };

const NOTHING_TO_RELEASE = async () => {};

/**
 * The docs export quota: one export per rolling window and billing account.
 * The plan sets the window (`docs.export_window_hours`): 24 hours on Free, 1
 * hour on paid plans. A window of 0 hours means no quota.
 *
 * The next export opens one window after the last export. The window comes
 * from the plan at the time of the check, so an upgrade opens the next export
 * sooner and a downgrade later. `reserve` is one conditional upsert, so two
 * parallel exports of the same account can never both pass, even on two API
 * processes.
 */
export class ExportQuota {
  constructor(private readonly deps: { readonly store: BillingStore; readonly clock: Clock }) {}

  /** Reads the quota. Writes nothing. */
  async status(accountId: string, entitlements: Entitlements): Promise<ExportQuotaStatus> {
    const windowHours = exportWindowHours(entitlements);
    if (windowHours === 0) return { unlimited: true, available: true };
    const lastExportAt = await this.deps.store.readLastExport(accountId);
    const opensAt = lastExportAt ? new Date(lastExportAt.getTime() + windowHours * HOUR_MS) : null;
    const open = opensAt === null || opensAt.getTime() <= this.deps.clock.now().getTime();
    return { unlimited: false, available: open, windowHours, lastExportAt, resetsAt: open ? null : opensAt };
  }

  /** Claims one export before it starts. A denied claim writes nothing. */
  async reserve(accountId: string, entitlements: Entitlements): Promise<ExportQuotaReservation> {
    const windowHours = exportWindowHours(entitlements);
    if (windowHours === 0) return { allowed: true, unlimited: true, release: NOTHING_TO_RELEASE };
    const windowMs = windowHours * HOUR_MS;
    const claim = await this.deps.store.claimExport({ accountId, now: this.deps.clock.now(), windowMs });
    if (!claim.claimed) {
      return { allowed: false, unlimited: false, windowHours, resetsAt: new Date(claim.lastExportAt.getTime() + windowMs) };
    }
    let released = false;
    return {
      allowed: true,
      unlimited: false,
      windowHours,
      resetsAt: new Date(claim.at.getTime() + windowMs),
      release: async () => {
        if (released) return;
        released = true;
        await this.deps.store.releaseExport({ accountId, at: claim.at });
      },
    };
  }
}

/**
 * The window length of the plan. `UNLIMITED` (an override) means no quota,
 * like 0. A missing, negative or fractional value is the strictest window (24
 * hours), so a catalog mistake never opens the quota.
 */
export function exportWindowHours(entitlements: Entitlements): number {
  const value = entitlements.limits[EXPORT_WINDOW_LIMIT_KEY];
  if (value !== undefined && isUnlimited(value)) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return 24;
  return value;
}
