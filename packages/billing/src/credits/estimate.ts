import type { MeterPricing } from "./pricing";

/**
 * The estimate before a run (spec 10.5 step 1 and "What the customer sees").
 * The estimate is 1.5 × the median usage of the last 5 runs of the same
 * action on the project, else `defaultEstimateCredits`.
 *
 * spec: the inputs are the usage part of past runs (settled credits minus the
 * base fee), because the first hold adds the base fee to the estimate.
 */
export interface RunEstimate {
  /** The usage credits that the first hold adds to the base fee. */
  readonly estimateCredits: number;
  /** "About low–high credits. Stops at cap." */
  readonly low: number;
  readonly high: number;
  readonly cap: number;
  readonly source: "history" | "default";
}

export const ESTIMATE_HISTORY_RUNS = 5;
const ESTIMATE_FACTOR_NUMERATOR = 3;
const ESTIMATE_FACTOR_DENOMINATOR = 2;

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : Math.ceil(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

/** `recentUsageCredits` is newest first. Only the first 5 count. */
export function estimateRun(input: { pricing: MeterPricing; capCredits: number; recentUsageCredits: readonly number[] }): RunEstimate {
  const recent = input.recentUsageCredits.slice(0, ESTIMATE_HISTORY_RUNS).filter((value) => Number.isFinite(value) && value >= 0);
  const cap = input.capCredits;
  const base = input.pricing.baseCredits;
  const clamp = (value: number) => Math.min(cap, value);
  if (recent.length === 0) {
    const estimateCredits = input.pricing.defaultEstimateCredits;
    const lowUsage = Math.ceil((estimateCredits * ESTIMATE_FACTOR_DENOMINATOR) / ESTIMATE_FACTOR_NUMERATOR);
    return { estimateCredits, low: clamp(base + lowUsage), high: clamp(base + estimateCredits), cap, source: "default" };
  }
  const mid = median(recent);
  const estimateCredits = Math.ceil((mid * ESTIMATE_FACTOR_NUMERATOR) / ESTIMATE_FACTOR_DENOMINATOR);
  return { estimateCredits, low: clamp(base + mid), high: clamp(base + estimateCredits), cap, source: "history" };
}
