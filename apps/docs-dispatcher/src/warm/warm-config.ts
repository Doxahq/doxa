import { DEFAULT_WARM_POOL_ORDER, isWarmPool } from "@doxahq/contracts/docs-warm-region";
import type { WarmPool } from "@doxahq/contracts/docs-warm-state";

import {
  isSiteInRollout,
  parseRolloutMode,
  parseSiteAllowlist,
  type SiteRollout,
} from "../rollout-policy";

/**
 * Flags of the regional warm job (M28). Every value is read here once, and
 * an invalid value falls back to the safe default with a warning.
 */
export interface WarmConfigEnv {
  DOXA_PROD_WARM_MODE?: string;
  DOXA_PROD_WARM_SITE_IDS?: string;
  DOXA_PROD_WARM_DEPLOY_SWEEP?: string;
  DOXA_WARM_MAX_ACTIVE_WARMERS?: string;
  DOXA_WARM_MAX_ACTIVE_WARMERS_PER_SITE?: string;
  DOXA_WARM_SWEEP_SITES_PER_TICK?: string;
  DOXA_WARM_MAX_PAGES?: string;
  DOXA_WARM_MAX_HOSTNAMES?: string;
  DOXA_WARM_SITE_FILLS_PER_HOUR?: string;
  DOXA_WARM_POOLS?: string;
}

export interface WarmConfig {
  rollout: SiteRollout;
  /** The renderer-deploy sweep (`off|on`). */
  deploySweep: boolean;
  /** The most regional warmers that fill at the same time, across all sites. */
  maxActiveWarmers: number;
  /** The most regional warmers of one site that fill at the same time. */
  maxActiveWarmersPerSite: number;
  /** The most sites one cron tick enqueues. */
  sweepSitesPerTick: number;
  /** The most pages of one site (D9). */
  maxPages: number;
  /** The most hostnames of one site. */
  maxHostnames: number;
  /** The most entrypoint fills of one site per hour, all pools together. */
  siteFillsPerHour: number;
  /** The pools to warm, in order after the publisher's pool. */
  pools: readonly WarmPool[];
}

const LIMITS = {
  maxActiveWarmers: { fallback: 24, max: 500 },
  maxActiveWarmersPerSite: { fallback: 4, max: 500 },
  sweepSitesPerTick: { fallback: 200, max: 5_000 },
  maxPages: { fallback: 500, max: 2_000 },
  maxHostnames: { fallback: 3, max: 10 },
  siteFillsPerHour: { fallback: 20_000, max: 1_000_000 },
} as const;

type LimitName = keyof typeof LIMITS;

const LIMIT_VARS: Readonly<Record<LimitName, keyof WarmConfigEnv>> = {
  maxActiveWarmers: "DOXA_WARM_MAX_ACTIVE_WARMERS",
  maxActiveWarmersPerSite: "DOXA_WARM_MAX_ACTIVE_WARMERS_PER_SITE",
  sweepSitesPerTick: "DOXA_WARM_SWEEP_SITES_PER_TICK",
  maxPages: "DOXA_WARM_MAX_PAGES",
  maxHostnames: "DOXA_WARM_MAX_HOSTNAMES",
  siteFillsPerHour: "DOXA_WARM_SITE_FILLS_PER_HOUR",
};

export function readWarmConfig(
  env: WarmConfigEnv,
  warn: (message: string) => void = console.warn,
): WarmConfig {
  const limit = (name: LimitName): number =>
    parseLimit(env[LIMIT_VARS[name]], LIMIT_VARS[name], LIMITS[name], warn);
  return {
    rollout: {
      mode: parseRolloutMode(env.DOXA_PROD_WARM_MODE, (invalid) =>
        warn(
          `[doxa-docs-dispatcher] Invalid DOXA_PROD_WARM_MODE ${JSON.stringify(invalid)}; the warm rollout is off.`,
        ),
      ),
      siteIds: parseSiteAllowlist(env.DOXA_PROD_WARM_SITE_IDS),
    },
    deploySweep: parseSwitch(env.DOXA_PROD_WARM_DEPLOY_SWEEP, warn),
    maxActiveWarmers: limit("maxActiveWarmers"),
    maxActiveWarmersPerSite: limit("maxActiveWarmersPerSite"),
    sweepSitesPerTick: limit("sweepSitesPerTick"),
    maxPages: limit("maxPages"),
    maxHostnames: limit("maxHostnames"),
    siteFillsPerHour: limit("siteFillsPerHour"),
    pools: parsePools(env.DOXA_WARM_POOLS, warn),
  };
}

export function isWarmSite(config: WarmConfig, siteId: string): boolean {
  return isSiteInRollout(config.rollout, siteId);
}

function parseSwitch(
  value: string | undefined,
  warn: (message: string) => void,
): boolean {
  if (value === "on") return true;
  if (value !== undefined && value !== "off") {
    warn(
      `[doxa-docs-dispatcher] Invalid DOXA_PROD_WARM_DEPLOY_SWEEP ${JSON.stringify(value)}; the deploy sweep is off.`,
    );
  }
  return false;
}

function parseLimit(
  value: string | undefined,
  name: string,
  limit: { fallback: number; max: number },
  warn: (message: string) => void,
): number {
  if (value === undefined || value.trim() === "") return limit.fallback;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= limit.max) {
    return parsed;
  }
  warn(
    `[doxa-docs-dispatcher] Invalid ${name} ${JSON.stringify(value)}; using ${limit.fallback}.`,
  );
  return limit.fallback;
}

/** Unknown names are dropped with a warning; an empty result uses the default. */
function parsePools(
  value: string | undefined,
  warn: (message: string) => void,
): readonly WarmPool[] {
  if (value === undefined || value.trim() === "") return DEFAULT_WARM_POOL_ORDER;
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const pools = [...new Set(names.filter(isWarmPool))];
  if (pools.length !== names.length) {
    warn(
      `[doxa-docs-dispatcher] Invalid DOXA_WARM_POOLS ${JSON.stringify(value)}; unknown or repeated pools are ignored.`,
    );
  }
  return pools.length > 0 ? pools : DEFAULT_WARM_POOL_ORDER;
}
