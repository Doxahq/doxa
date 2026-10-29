import { WARM_POOLS, warmPoolSchema, type WarmPool } from "./docs-warm-state";

/**
 * Where a Cloudflare request comes from, as one of the eight upper-tier cache
 * pools (spike S1). One function for every reader: the docs dispatcher (the
 * visitor's pool), the regional warm job (an anchor's own pool) and the API
 * edge (the publisher's pool, M45). Pure: no I/O, no Workers types.
 * See docs/current/production-docs-caching.md, "Regional warm job".
 */

/** The parts of `request.cf` that place a request. Every field may be absent. */
export interface WarmLocation {
  colo?: unknown;
  continent?: unknown;
  country?: unknown;
  latitude?: unknown;
  longitude?: unknown;
}

/**
 * Data centers whose upper tier spike S1 measured. A colo maps to the pool
 * that its Workers Cache fills land in.
 */
export const WARM_POOL_COLOS: Readonly<Record<WarmPool, readonly string[]>> = {
  "us-west": ["LAX", "DFW", "DEN", "SEA", "SJC"],
  "us-east": ["ATL", "MIA", "ORD", "EWR", "IAD"],
  "eu-west": ["MRS", "CDG", "AMS", "MAD", "BCN"],
  "eu-east": ["MXP", "WAW", "OTP", "FRA", "ARN"],
  "asia-ne": ["KIX", "ICN", "NRT"],
  "hong-kong": ["HKG", "TPE"],
  singapore: ["SIN"],
  oceania: ["SYD", "BNE", "MEL", "PER"],
};

/**
 * The Durable Object location hint that places a pool's anchor (S1). Asia
 * hints are not fixed places, so every anchor checks its own colo (F42).
 */
export const WARM_POOL_LOCATION_HINTS = {
  "us-west": "wnam",
  "us-east": "enam",
  "eu-west": "weur",
  "eu-east": "eeur",
  "asia-ne": "apac-ne",
  "hong-kong": "apac",
  singapore: "apac-se",
  oceania: "oc",
} as const satisfies Readonly<Record<WarmPool, string>>;

export type WarmPoolLocationHint =
  (typeof WARM_POOL_LOCATION_HINTS)[WarmPool];

/**
 * The default warm order after the publisher's pool (M45): the pools with
 * the most visitors first.
 */
export const DEFAULT_WARM_POOL_ORDER: readonly WarmPool[] = [
  "us-east",
  "eu-west",
  "us-west",
  "asia-ne",
  "singapore",
  "hong-kong",
  "eu-east",
  "oceania",
];

const COLO_POOLS: ReadonlyMap<string, WarmPool> = new Map(
  WARM_POOLS.flatMap((pool) =>
    WARM_POOL_COLOS[pool].map((colo) => [colo, pool] as const),
  ),
);

const COUNTRY_POOLS: Readonly<Record<string, WarmPool>> = {
  // Western Europe: the eu-west colos (MRS, CDG, AMS, MAD, BCN).
  FR: "eu-west",
  ES: "eu-west",
  PT: "eu-west",
  NL: "eu-west",
  BE: "eu-west",
  LU: "eu-west",
  GB: "eu-west",
  IE: "eu-west",
  MC: "eu-west",
  AD: "eu-west",
  // Central, northern and eastern Europe: the eu-east colos.
  DE: "eu-east",
  IT: "eu-east",
  CH: "eu-east",
  AT: "eu-east",
  PL: "eu-east",
  RO: "eu-east",
  SE: "eu-east",
  // Asia: three pools (F42).
  JP: "asia-ne",
  KR: "asia-ne",
  HK: "hong-kong",
  TW: "hong-kong",
  MO: "hong-kong",
  SG: "singapore",
  MY: "singapore",
  TH: "singapore",
  VN: "singapore",
  PH: "singapore",
  // S1: Middle East hints land in eu-east (F43).
  AE: "eu-east",
  SA: "eu-east",
  QA: "eu-east",
  BH: "eu-east",
  KW: "eu-east",
  OM: "eu-east",
  IL: "eu-east",
  JO: "eu-east",
  TR: "eu-east",
};

/** West of this longitude, a European request is closer to the eu-west colos. */
const EU_WEST_MAX_LONGITUDE = 7;
/** West of this longitude, a North American request is closer to us-west. */
const US_WEST_MAX_LONGITUDE = -100;

/** The pool of a measured colo, else null. */
export function warmPoolForColo(colo: unknown): WarmPool | null {
  const code = readString(colo)?.toUpperCase();
  return code ? (COLO_POOLS.get(code) ?? null) : null;
}

/**
 * The upper-tier pool that serves a request: the S1 colo table first, then a
 * geographic guess, else null ("unknown"). India and Indonesia stay null
 * until their pools are measured (F43). `latitude` is accepted but unused:
 * no measured pool boundary needs it yet.
 */
export function warmPoolForLocation(cf: unknown): WarmPool | null {
  const location = readLocation(cf);
  if (!location) return null;
  return warmPoolForColo(location.colo) ?? poolForGeography(location);
}

/** True for a value that names one of the eight pools. */
export function isWarmPool(value: unknown): value is WarmPool {
  return warmPoolSchema.safeParse(value).success;
}

/**
 * The warm order of one job: the priority pools first (the publisher's),
 * then `order`, each pool once, only pools in `order`.
 */
export function orderWarmPools(
  priority: readonly WarmPool[],
  order: readonly WarmPool[] = DEFAULT_WARM_POOL_ORDER,
): WarmPool[] {
  const allowed = new Set(order);
  return [
    ...new Set([...priority.filter((pool) => allowed.has(pool)), ...order]),
  ];
}

function poolForGeography(location: WarmLocation): WarmPool | null {
  const country = readString(location.country)?.toUpperCase();
  if (country && country in COUNTRY_POOLS) return COUNTRY_POOLS[country] ?? null;
  const longitude = readNumber(location.longitude);
  switch (readString(location.continent)?.toUpperCase()) {
    case "NA":
      return longitude !== null && longitude < US_WEST_MAX_LONGITUDE
        ? "us-west"
        : "us-east";
    // S1: South America hints land in us-east, Africa hints in eu-west.
    case "SA":
      return "us-east";
    case "AF":
      return "eu-west";
    case "EU":
      if (longitude === null) return null;
      return longitude < EU_WEST_MAX_LONGITUDE ? "eu-west" : "eu-east";
    case "OC":
      return "oceania";
    default:
      return null;
  }
}

/** `request.cf` is typed as a union; read only the fields used here. */
function readLocation(cf: unknown): WarmLocation | null {
  if (typeof cf !== "object" || cf === null) return null;
  return {
    colo: "colo" in cf ? cf.colo : undefined,
    continent: "continent" in cf ? cf.continent : undefined,
    country: "country" in cf ? cf.country : undefined,
    latitude: "latitude" in cf ? cf.latitude : undefined,
    longitude: "longitude" in cf ? cf.longitude : undefined,
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** `request.cf.longitude` is a string; tests may pass a number. */
function readNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
