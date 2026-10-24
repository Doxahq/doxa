import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, buildConnector, setGlobalDispatcher } from "undici";

/** The error code of a connection that the guard refuses. */
export const BLOCKED_ADDRESS_CODE = "DOXA_NON_PUBLIC_ADDRESS";

/**
 * Addresses that a strictly public fetch must not reach: private networks,
 * loopback, link-local (the ECS task metadata and credentials endpoints are
 * 169.254.170.2), carrier-grade NAT, benchmarking, multicast and reserved.
 */
const NON_PUBLIC = buildBlockList([
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  // Unspecified, loopback and the old IPv4-compatible form (::a.b.c.d).
  ["::", 96, "ipv6"],
  // NAT64 and 6to4 carry an IPv4 address inside.
  ["64:ff9b::", 96, "ipv6"],
  ["64:ff9b:1::", 48, "ipv6"],
  ["2002::", 16, "ipv6"],
  ["100::", 64, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
]);

function buildBlockList(ranges: readonly [network: string, prefix: number, family: "ipv4" | "ipv6"][]): BlockList {
  const list = new BlockList();
  for (const [network, prefix, family] of ranges) list.addSubnet(network, prefix, family);
  return list;
}

/** True for an address on the public internet. An IPv4-mapped IPv6 address is checked as IPv4. */
export function isPublicAddress(address: string): boolean {
  const mapped = mappedIPv4(address);
  if (mapped) return isPublicAddress(mapped);
  const family = isIP(address);
  if (family === 0) return false;
  return !NON_PUBLIC.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** The IPv4 address inside ::ffff:a.b.c.d or ::ffff:xxxx:xxxx, in any spelling. */
function mappedIPv4(address: string): string | null {
  if (isIP(address) !== 6) return null;
  // The URL parser writes the canonical form: [::ffff:7f00:1].
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!match) return null;
  const high = Number.parseInt(match[1]!, 16);
  const low = Number.parseInt(match[2]!, 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

function blockedError(host: string, address: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`Blocked a fetch to ${host} (${address}): not a public address.`);
  error.code = BLOCKED_ADDRESS_CODE;
  return error;
}

/** `dns.lookup` that fails when any address of the host is not public, so a DNS answer cannot point inside. */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error, "", 4);
    const blocked = addresses.find(({ address }) => !isPublicAddress(address));
    if (blocked) return callback(blockedError(hostname, blocked.address), "", 4);
    if (options.all) return callback(null, addresses);
    const first = addresses[0];
    if (!first) return callback(new Error(`No address for ${hostname}.`), "", 4);
    callback(null, first.address, first.family);
  });
};

/** An undici connector that refuses non-public IP literals and checks DNS answers with `publicOnlyLookup`. */
export function createPublicOnlyConnector(): buildConnector.connector {
  const connect = buildConnector({ lookup: publicOnlyLookup });
  return (options, callback) => {
    const host = options.hostname.replace(/^\[(.*)\]$/, "$1");
    if (isIP(host) !== 0 && !isPublicAddress(host)) {
      callback(blockedError(host, host), null);
      return;
    }
    connect(options, callback);
  };
}

/**
 * Makes every `fetch` of this process strictly public, as the Worker's
 * `global_fetch_strictly_public` flag does, and sets that flag where
 * `@cloudflare/workers-oauth-provider` reads it. The provider fetches Client
 * ID Metadata Documents from URLs that clients choose, and needs this guard.
 *
 * `strict-public-fetch-preload.ts` calls it before any other module loads.
 * The server then calls `assertStrictPublicFetch` before it serves requests.
 */
export function installStrictPublicFetch(): void {
  setGlobalDispatcher(new Agent({ connect: createPublicOnlyConnector() }));
  Reflect.set(globalThis, "Cloudflare", { compatibilityFlags: { global_fetch_strictly_public: true } });
}

/** Fails unless a fetch to 127.0.0.1 fails with the guard's error. */
export async function assertStrictPublicFetch(): Promise<void> {
  try {
    // Any port that fetch allows. The guard refuses before it connects.
    await fetch("http://127.0.0.1:65530/", { signal: AbortSignal.timeout(2000) });
  } catch (cause) {
    if (errorCodeOf(cause) === BLOCKED_ADDRESS_CODE) return;
    throw new Error("The strict public fetch guard did not apply to fetch().", { cause });
  }
  throw new Error("The strict public fetch guard did not apply to fetch(): a loopback fetch succeeded.");
}

/** fetch() wraps the connection error in `cause`. */
function errorCodeOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}
