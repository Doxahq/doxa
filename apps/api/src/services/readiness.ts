import { createDb } from "@doxahq/db";
import { sql } from "drizzle-orm";
import type { Env } from "../env";

/** One dependency that the API needs to serve requests. */
export interface ReadinessCheck {
  name: string;
  run(): Promise<unknown>;
}

export type ReadinessCheckResult = "ok" | "failed" | "timeout";

export interface ReadinessReport {
  ok: boolean;
  checks: Record<string, ReadinessCheckResult>;
}

/** A check that takes longer than this counts as down: users would see the same delay. */
export const READINESS_CHECK_TIMEOUT_MS = 3_000;

/**
 * External monitors call the readiness route from several regions every
 * minute. One report serves every call in this window, so the route costs at
 * most one database query and one Valkey read per process per window.
 */
export const READINESS_REUSE_MS = 10_000;

/**
 * Runs every check at the same time. The report names each check and its
 * result, never an error message, because the route is public.
 */
export async function runReadinessChecks(
  checks: readonly ReadinessCheck[],
  timeoutMs = READINESS_CHECK_TIMEOUT_MS,
): Promise<ReadinessReport> {
  const results = await Promise.all(checks.map((check) => runOne(check, timeoutMs)));
  const entries = checks.map((check, index) => [check.name, results[index]] as const);
  return {
    ok: results.every((result) => result === "ok"),
    checks: Object.fromEntries(entries),
  };
}

async function runOne(check: ReadinessCheck, timeoutMs: number): Promise<ReadinessCheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ReadinessCheckResult>((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  // A check that throws before it returns a promise counts as failed too.
  const run = Promise.resolve().then(() => check.run()).then(
    (): ReadinessCheckResult => "ok",
    (): ReadinessCheckResult => "failed",
  );
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The dependencies of a request: Postgres, and Valkey through the auth KV. */
export function readinessChecksFromEnv(env: Env): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [
    { name: "database", run: () => createDb(env).execute(sql`select 1`) },
  ];
  const kv = env.AUTH_KV;
  if (kv) checks.push({ name: "cache", run: () => kv.get("readiness:probe") });
  return checks;
}

/**
 * Reuses one report for `reuseMs`. Concurrent callers share the report that
 * is being made, so a burst of calls starts one set of checks. Each call
 * passes its own input (the request env), because the checks of a new report
 * must use the env of the request that starts them.
 */
export function createReadinessProbe<Input>(
  makeChecks: (input: Input) => readonly ReadinessCheck[],
  options: { reuseMs?: number; timeoutMs?: number; now?: () => number } = {},
): (input: Input) => Promise<ReadinessReport> {
  const reuseMs = options.reuseMs ?? READINESS_REUSE_MS;
  const now = options.now ?? Date.now;
  let last: { at: number; report: Promise<ReadinessReport> } | undefined;

  return (input) => {
    const at = now();
    if (last && at - last.at < reuseMs) return last.report;
    const report = runReadinessChecks(makeChecks(input), options.timeoutMs);
    last = { at, report };
    return report;
  };
}
