import { EXPORTS_PER_WINDOW, ExportQuota, type BillingEnforcement } from "@doxahq/billing";
import type { Env } from "../../env";
import { billingConfigFor } from "./config";
import { billingCoreFromEnv, type BillingCore } from "./core";
import { defaultBillingDenialLogger, type BillingDenialLogger } from "./enforcement";

/**
 * The docs export quota of a project's billing account (decided 2026-11-16):
 * one export per rolling window, 24 hours on Free and 1 hour on paid plans
 * (`docs.export_window_hours` in the catalog). The next export opens one
 * window after the last export. The project's billing account pays, so a team
 * project counts against the team account.
 *
 * - `off` (self-hosted defaults): no quota and no billing read.
 * - `shadow`: claims and logs a denial, then allows the export.
 * - `on`: denies above the quota.
 *
 * A billing read that fails denies the export (`ExportBillingUnavailableError`):
 * a broken quota must never mean unlimited exports.
 */

export const EXPORT_LIMIT_KEY = "docs.export_window_hours";

export interface ExportQuotaView {
  /** False while the window after the last export is open. */
  readonly available: boolean;
  /** Null while billing enforcement is off. */
  readonly plan: string | null;
  /** Null when no quota applies. */
  readonly windowHours: number | null;
  /** When the next export opens, or null when an export is possible now. */
  readonly resetsAt: string | null;
}

export type ExportReservation =
  | { readonly allowed: true; readonly quota: ExportQuotaView; release(): Promise<void> }
  | { readonly allowed: false; readonly quota: ExportQuotaView };

export interface ExportBilling {
  readonly mode: BillingEnforcement;
  status(projectId: string): Promise<ExportQuotaView>;
  /** Counts one export of the project's account before the stream starts. */
  reserve(projectId: string): Promise<ExportReservation>;
}

export class ExportBillingUnavailableError extends Error {
  constructor(cause: unknown) {
    super("The export quota could not be read.", { cause });
    this.name = "ExportBillingUnavailableError";
  }
}

export interface ExportBillingDeps {
  readonly mode: BillingEnforcement;
  readonly core: () => Pick<BillingCore, "entitlements" | "store" | "clock">;
  readonly log?: BillingDenialLogger;
}

const NO_QUOTA: ExportQuotaView = { available: true, plan: null, windowHours: null, resetsAt: null };

export function createExportBilling(deps: ExportBillingDeps): ExportBilling {
  let built: Pick<BillingCore, "entitlements" | "store" | "clock"> | null = null;
  const core = () => (built ??= deps.core());
  const quota = () => new ExportQuota({ store: core().store, clock: core().clock });
  const log = deps.log ?? defaultBillingDenialLogger;
  const { mode } = deps;

  async function guarded<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (cause) {
      const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error";
      console.warn(JSON.stringify({ service: "doxa-api", event: "billing.export_quota_error", mode, message }));
      throw new ExportBillingUnavailableError(cause);
    }
  }

  return {
    mode,
    async status(projectId) {
      if (mode === "off") return NO_QUOTA;
      return guarded(async () => {
        const view = await core().entitlements.forProject(projectId);
        const status = await quota().status(view.account.id, view.entitlements);
        if (status.unlimited) return { ...NO_QUOTA, plan: view.entitlements.plan };
        // Shadow mode never blocks, so the button stays on.
        const available = status.available || mode === "shadow";
        return {
          available,
          plan: view.entitlements.plan,
          windowHours: status.windowHours,
          resetsAt: available || !status.resetsAt ? null : status.resetsAt.toISOString(),
        };
      });
    },
    async reserve(projectId) {
      if (mode === "off") return { allowed: true, quota: NO_QUOTA, release: async () => {} };
      const { view, reservation } = await guarded(async () => {
        const view = await core().entitlements.forProject(projectId);
        return { view, reservation: await quota().reserve(view.account.id, view.entitlements) };
      });
      const plan = view.entitlements.plan;
      if (reservation.unlimited) {
        return { allowed: true, quota: { ...NO_QUOTA, plan }, release: async () => {} };
      }
      const quotaView: ExportQuotaView = {
        available: false,
        plan,
        windowHours: reservation.windowHours,
        resetsAt: reservation.resetsAt.toISOString(),
      };
      if (reservation.allowed) return { allowed: true, quota: quotaView, release: () => reservation.release() };
      log({
        key: EXPORT_LIMIT_KEY,
        mode,
        kind: "denied",
        plan,
        projectId,
        accountId: view.account.id,
        limit: reservation.windowHours,
        used: EXPORTS_PER_WINDOW,
      });
      if (mode === "shadow") return { allowed: true, quota: quotaView, release: async () => {} };
      return { allowed: false, quota: quotaView };
    },
  };
}

/** The export billing of one request env. With the defaults it builds no billing core. */
export function exportBillingFromEnv(env: Env): ExportBilling {
  const config = billingConfigFor(env);
  return createExportBilling({ mode: config.enforcement, core: () => billingCoreFromEnv(env) });
}
