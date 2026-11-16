import type { BillingEnforcement } from "@doxahq/billing";

/** One `billing.denial` line (billing spec 18): the key, the plan and the mode. */
export interface BillingDenial {
  readonly key: string;
  readonly mode: Exclude<BillingEnforcement, "off">;
  readonly plan: string | null;
  /**
   * `denied`: a check that billing would refuse (shadow) or refused (on).
   * `stricter_limit`: a shadow seam whose plan value is stricter than today's
   * value; the caller compares usage later, so this is the earliest signal.
   */
  readonly kind: "denied" | "stricter_limit";
  readonly projectId?: string | null;
  readonly accountId?: string | null;
  readonly limit: number | "unlimited" | boolean | string;
  readonly used?: number | null;
  /** Today's value, for a shadow comparison. */
  readonly current?: number | boolean | string | null;
}

export type BillingDenialLogger = (denial: BillingDenial) => void;

/** Structured log line in the API's usual shape. */
export const consoleBillingDenialLogger: BillingDenialLogger = (denial) => {
  console.log(JSON.stringify({ service: "doxa-api", event: "billing.denial", ...denial }));
};

const SHADOW_LOG_TTL_MS = 10 * 60 * 1000;
const SHADOW_LOG_MAX_KEYS = 10_000;

/**
 * Shadow seams run on every read of a plan value (site config, uploads,
 * search). One line for each project and key every 10 minutes is enough to
 * compare shadow denials with the plan limits (spec phase 4), without a log
 * line on every page read. `denied` lines are never deduplicated.
 */
export function dedupeStricterLimitLogs(
  log: BillingDenialLogger,
  options: { ttlMs?: number; now?: () => number } = {},
): BillingDenialLogger {
  const ttlMs = options.ttlMs ?? SHADOW_LOG_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const last = new Map<string, number>();
  return (denial) => {
    if (denial.kind !== "stricter_limit") return log(denial);
    const key = `${denial.projectId ?? denial.accountId ?? ""}:${denial.key}`;
    const at = now();
    const previous = last.get(key);
    if (previous !== undefined && at - previous < ttlMs) return;
    if (last.size >= SHADOW_LOG_MAX_KEYS) last.clear();
    last.set(key, at);
    log(denial);
  };
}

/** The process-wide logger of the seams. */
export const defaultBillingDenialLogger: BillingDenialLogger = dedupeStricterLimitLogs(consoleBillingDenialLogger);
