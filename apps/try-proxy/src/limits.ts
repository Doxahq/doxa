import type { DocsTryContext } from "@doxahq/contracts/docs-try";

import type { TryProxyEnv } from "./env";

const DEFAULT_SITE_DAILY_LIMIT = 5_000;
const DEFAULT_TARGET_DAILY_LIMIT = 50_000;
const RATE_LIMIT_RETRY_SECONDS = 60;

function readLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Seconds to wait when over a limit, or null when the send can go on.
 *
 * It checks every limit of the client and the site before any limit of the
 * target, and stops at the first refusal. All sites with a target share its
 * limits, so a request that this site's own limits refuse must not use them.
 */
export async function applyTryLimits(
  env: TryProxyEnv,
  context: DocsTryContext,
  targetHost: string,
  now: Date,
): Promise<number | null> {
  const client = await env.TRY_CLIENT.limit({ key: `${context.siteId}:${context.clientKey}` });
  if (!client.success) return RATE_LIMIT_RETRY_SECONDS;
  const site = await env.TRY_SITE.limit({ key: context.siteId });
  if (!site.success) return RATE_LIMIT_RETRY_SECONDS;

  const day = now.toISOString().slice(0, 10);
  const siteBudget = await takeBudget(
    env,
    `site:${context.siteId}`,
    readLimit(env.DOXA_TRY_SITE_DAILY_LIMIT, DEFAULT_SITE_DAILY_LIMIT),
    day,
  );
  if (!siteBudget) return secondsUntilNextUtcDay(now);

  // A refusal from here on uses one count of the site's budget. That costs only
  // this site, and this site cannot reach the target at that moment.
  const target = await env.TRY_TARGET.limit({ key: targetHost });
  if (!target.success) return RATE_LIMIT_RETRY_SECONDS;
  const targetBudget = await takeBudget(
    env,
    `target:${targetHost}`,
    readLimit(env.DOXA_TRY_TARGET_DAILY_LIMIT, DEFAULT_TARGET_DAILY_LIMIT),
    day,
  );
  return targetBudget ? null : secondsUntilNextUtcDay(now);
}

/**
 * A failure here allows the send. The rate limit bindings still apply, and a
 * storage fault must not stop every playground on every site.
 */
async function takeBudget(
  env: TryProxyEnv,
  name: string,
  limit: number,
  day: string,
): Promise<boolean> {
  try {
    return await env.TRY_BUDGET.get(env.TRY_BUDGET.idFromName(name)).take(limit, day);
  } catch {
    return true;
  }
}

function secondsUntilNextUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.ceil((next - now.getTime()) / 1000);
}
