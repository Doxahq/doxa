/**
 * The warm job's log events, one JSON line each (spec § 11). IDs, counts and
 * outcomes only: never page content, never a request payload.
 */
export type WarmLogEvent =
  | "docs_warm_job"
  | "docs_warm_region"
  | "docs_warm_lock"
  | "docs_warm_slots"
  | "docs_warm_sweep"
  | "docs_warm_anchor";

export type WarmLogFields = Record<
  string,
  string | number | boolean | null | undefined | readonly string[]
>;

export function logWarm(event: WarmLogEvent, fields: WarmLogFields): void {
  console.info(JSON.stringify({ event, ...fields }));
}

export function describeWarmError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : "Unknown error";
}
