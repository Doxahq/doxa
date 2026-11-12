import type { DnsHostProvider, DocsDomainDnsHost } from "@doxahq/contracts";
import { z } from "zod";

/**
 * Finds the DNS host of a hostname from public DNS: the nameservers of the
 * zone that holds the hostname name the service where the CNAME record goes.
 * The dashboard uses the result only to choose setup instructions, so every
 * failure gives an unknown host instead of an error.
 */

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DEFAULT_LOOKUP_TIMEOUT_MS = 3_000;
const DNS_RECORD_TYPE_NS = 2;
const DNS_STATUS_NOERROR = 0;
const DNS_STATUS_NXDOMAIN = 3;

/**
 * The most zone candidates to look up for one hostname. Zones sit near the
 * top of a name, so a longer hostname drops its most specific candidates.
 */
const MAX_ZONE_CANDIDATES = 8;

interface DnsHostRule {
  provider: DnsHostProvider;
  pattern: RegExp;
}

/** Nameserver patterns, matched against lower-case names without the final dot. */
const DNS_HOST_RULES: readonly DnsHostRule[] = [
  { provider: "cloudflare", pattern: /\.ns\.cloudflare\.com$/ },
  { provider: "namecheap", pattern: /\.registrar-servers\.com$/ },
  { provider: "godaddy", pattern: /\.domaincontrol\.com$/ },
  { provider: "route53", pattern: /^ns-\d+\.awsdns-\d+\.(?:com|net|org|co\.uk)$/ },
  { provider: "vercel", pattern: /\.vercel-dns\.com$/ },
  { provider: "porkbun", pattern: /\.porkbun\.com$/ },
  { provider: "digitalocean", pattern: /^ns\d+\.digitalocean\.com$/ },
];

/** The provider whose pattern matches one nameserver, or null. */
export function matchNameserver(nameserver: string): DnsHostProvider | null {
  const name = normalizeDnsName(nameserver);
  return DNS_HOST_RULES.find((rule) => rule.pattern.test(name))?.provider ?? null;
}

/**
 * The DNS host of a zone. Every nameserver must belong to the same provider:
 * a zone served by two providers (or by an unknown one) gives null, because
 * Doxa cannot tell which one the user edits.
 */
export function classifyNameservers(nameservers: readonly string[]): DnsHostProvider | null {
  if (nameservers.length === 0) return null;
  const providers = new Set(nameservers.map(matchNameserver));
  if (providers.size !== 1) return null;
  const [provider] = providers;
  return provider ?? null;
}

/**
 * Names that can be the zone of `hostname`, most specific first, for example
 * `docs.example.co.uk`, `example.co.uk`, `co.uk`. A bare top-level domain is
 * never a candidate.
 */
export function listZoneCandidates(hostname: string): string[] {
  const labels = normalizeDnsName(hostname).split(".").filter(Boolean);
  const candidates: string[] = [];
  for (let start = 0; start <= labels.length - 2; start += 1) {
    candidates.push(labels.slice(start).join("."));
  }
  return candidates.slice(-MAX_ZONE_CANDIDATES);
}

/** Lower case, without the final root dot that DNS answers carry. */
export function normalizeDnsName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

/** Reads the NS records that sit at exactly one name. */
export interface NameserverResolver {
  /**
   * The nameservers delegated at `name`; empty when `name` is not a zone.
   * Throws when the lookup fails, so a failure is never read as "no zone".
   */
  lookupNameservers(name: string, signal: AbortSignal): Promise<string[]>;
}

const dohAnswerSchema = z.object({
  name: z.string(),
  type: z.number(),
  data: z.string(),
});

const dohResponseSchema = z.object({
  Status: z.number(),
  Answer: z.array(dohAnswerSchema).optional(),
});

interface DohNameserverResolverOptions {
  fetcher?: typeof fetch;
  endpoint?: string;
}

/** Looks up NS records through the DNS over HTTPS JSON API. */
export class DohNameserverResolver implements NameserverResolver {
  private readonly fetcher: typeof fetch;
  private readonly endpoint: string;

  constructor(options: DohNameserverResolverOptions = {}) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.endpoint = options.endpoint ?? DOH_ENDPOINT;
  }

  async lookupNameservers(name: string, signal: AbortSignal): Promise<string[]> {
    const url = new URL(this.endpoint);
    url.searchParams.set("name", name);
    url.searchParams.set("type", "NS");

    const response = await this.fetcher(url, {
      headers: { accept: "application/dns-json" },
      signal,
    });
    if (!response.ok) {
      throw new Error(`DNS over HTTPS lookup failed with HTTP ${response.status}.`);
    }

    const body = dohResponseSchema.parse(await response.json());
    if (body.Status === DNS_STATUS_NXDOMAIN) return [];
    if (body.Status !== DNS_STATUS_NOERROR) {
      throw new Error(`DNS over HTTPS lookup failed with DNS status ${body.Status}.`);
    }

    // A name with a CNAME is not a zone. The resolver follows the CNAME and
    // answers with the target's records, so keep only records at `name`.
    const owner = normalizeDnsName(name);
    return (body.Answer ?? [])
      .filter((answer) => answer.type === DNS_RECORD_TYPE_NS && normalizeDnsName(answer.name) === owner)
      .map((answer) => normalizeDnsName(answer.data));
  }
}

export interface DnsHostDetector {
  detect(hostname: string): Promise<DocsDomainDnsHost>;
}

interface NameserverDnsHostDetectorOptions {
  resolver?: NameserverResolver;
  timeoutMs?: number;
  onLookupError?: (hostname: string, error: unknown) => void;
}

export const UNKNOWN_DNS_HOST: DocsDomainDnsHost = Object.freeze({
  provider: null,
  zone: null,
  nameservers: [],
});

/**
 * Finds the zone of a hostname (the most specific candidate with NS records)
 * and classifies its nameservers. The lookups run in parallel under one
 * time budget.
 */
export class NameserverDnsHostDetector implements DnsHostDetector {
  private readonly resolver: NameserverResolver;
  private readonly timeoutMs: number;
  private readonly onLookupError: (hostname: string, error: unknown) => void;

  constructor(options: NameserverDnsHostDetectorOptions = {}) {
    this.resolver = options.resolver ?? new DohNameserverResolver();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
    this.onLookupError = options.onLookupError ?? logLookupError;
  }

  async detect(hostname: string): Promise<DocsDomainDnsHost> {
    const candidates = listZoneCandidates(hostname);
    const signal = AbortSignal.timeout(this.timeoutMs);
    const lookups = await Promise.allSettled(
      candidates.map((candidate) => this.resolver.lookupNameservers(candidate, signal)),
    );

    for (const [index, lookup] of lookups.entries()) {
      // A failed lookup of a more specific name hides whether that name is
      // the zone, so a less specific answer cannot be trusted.
      if (lookup.status === "rejected") {
        this.onLookupError(hostname, lookup.reason);
        return UNKNOWN_DNS_HOST;
      }
      if (lookup.value.length > 0) {
        const nameservers = [...new Set(lookup.value)].sort();
        return {
          provider: classifyNameservers(nameservers),
          zone: candidates[index] ?? null,
          nameservers,
        };
      }
    }
    return UNKNOWN_DNS_HOST;
  }
}

export function createDnsHostDetector(): DnsHostDetector {
  return new NameserverDnsHostDetector();
}

function logLookupError(hostname: string, error: unknown): void {
  console.warn("DNS host lookup failed.", {
    hostname,
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
  });
}
