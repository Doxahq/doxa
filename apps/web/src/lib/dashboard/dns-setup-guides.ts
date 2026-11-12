import { DNS_HOST_PROVIDERS, type DnsHostProvider } from "@doxahq/contracts"

/**
 * DNS setup steps for each recognized DNS host, plus generic steps for any
 * other host. The steps stay high level on purpose: they name the place to go,
 * not the buttons to click, so they stay correct when a provider changes its
 * dashboard. Each guide links to the provider's own help page for the details.
 */

export type DnsSetupGuideId = DnsHostProvider | "other"

export const DNS_SETUP_GUIDE_IDS: readonly DnsSetupGuideId[] = [...DNS_HOST_PROVIDERS, "other"]

/** A run of plain text, or a value that the UI shows as code. */
export type DnsSetupTextPart = string | { code: string }

/** A sentence of the guide, or the place where the record to add is shown. */
export type DnsSetupStep =
  | { kind: "text"; id: string; parts: readonly DnsSetupTextPart[] }
  | { kind: "record"; id: "record" }

export interface DnsSetupGuide {
  id: DnsSetupGuideId
  /** The DNS host name for display, or null for the generic guide. */
  hostName: string | null
  helpUrl: string | null
  steps: readonly DnsSetupStep[]
}

interface DnsHostDetails {
  name: string
  /** Where the DNS records live, as it completes "Open the DNS records for X in …". */
  recordsPlace: string
  helpUrl: string
  /** Extra guidance when the host can proxy a record. */
  proxyNote?: string
}

const DNS_HOST_DETAILS: Record<DnsHostProvider, DnsHostDetails> = {
  cloudflare: {
    name: "Cloudflare",
    recordsPlace: "the Cloudflare dashboard",
    helpUrl: "https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/",
    proxyNote: "Set the proxy status to DNS only (grey cloud).",
  },
  namecheap: {
    name: "Namecheap",
    recordsPlace: "your Namecheap account (Advanced DNS)",
    helpUrl: "https://www.namecheap.com/support/knowledgebase/article.aspx/9646/2237/how-to-create-a-cname-record-for-your-domain/",
  },
  godaddy: {
    name: "GoDaddy",
    recordsPlace: "your GoDaddy account",
    helpUrl: "https://www.godaddy.com/help/add-a-cname-record-19236",
  },
  route53: {
    name: "Amazon Route 53",
    recordsPlace: "the Route 53 hosted zone in the AWS console",
    helpUrl: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-creating.html",
  },
  vercel: {
    name: "Vercel",
    recordsPlace: "the Vercel dashboard (Domains)",
    helpUrl: "https://vercel.com/docs/domains/managing-dns-records",
  },
  porkbun: {
    name: "Porkbun",
    recordsPlace: "your Porkbun account",
    helpUrl: "https://kb.porkbun.com/article/68-how-to-edit-dns-records",
  },
  digitalocean: {
    name: "DigitalOcean",
    recordsPlace: "the DigitalOcean control panel (Networking)",
    helpUrl: "https://docs.digitalocean.com/products/networking/dns/how-to/manage-records/",
  },
}

const GENERIC_PROXY_NOTE = "If your DNS host offers a proxy or CDN for the record, turn it off."

export function getDnsHostName(provider: DnsHostProvider): string {
  return DNS_HOST_DETAILS[provider].name
}

export function getDnsSetupGuideLabel(id: DnsSetupGuideId): string {
  return id === "other" ? "Other DNS host" : getDnsHostName(id)
}

export function isDnsSetupGuideId(value: string): value is DnsSetupGuideId {
  return DNS_SETUP_GUIDE_IDS.some((id) => id === value)
}

export function buildDnsSetupGuide(id: DnsSetupGuideId, zone: string | null): DnsSetupGuide {
  const host = id === "other" ? null : DNS_HOST_DETAILS[id]
  const steps: DnsSetupStep[] = [
    { kind: "text", id: "open", parts: openRecordsStep(host, zone) },
    { kind: "record", id: "record" },
  ]
  const proxyNote = host ? host.proxyNote : GENERIC_PROXY_NOTE
  if (proxyNote) steps.push({ kind: "text", id: "proxy", parts: [proxyNote] })
  steps.push({ kind: "text", id: "save", parts: ["Save it, then click Check again. DNS changes can take a few minutes."] })

  return { id, hostName: host?.name ?? null, helpUrl: host?.helpUrl ?? null, steps }
}

/**
 * The value to type in the record's name field. Most DNS dashboards add the
 * zone themselves, so a subdomain is entered relative to it (`docs`) and the
 * zone apex as `@`. Without a known zone it is the full hostname.
 */
export function getDnsRecordNameValue(hostname: string, zone: string | null): string {
  const relativeName = getRelativeRecordName(hostname, zone)
  if (relativeName) return relativeName
  if (zone && normalizeName(hostname) === normalizeName(zone)) return "@"
  return normalizeName(hostname)
}

/**
 * The record name relative to its zone, as most DNS dashboards expect it:
 * `docs` for `docs.example.com` in the `example.com` zone. Null when the
 * hostname is the zone itself or is not inside it.
 */
export function getRelativeRecordName(hostname: string, zone: string | null): string | null {
  if (!zone) return null
  const host = normalizeName(hostname)
  const suffix = `.${normalizeName(zone)}`
  if (!host.endsWith(suffix) || host.length === suffix.length) return null
  return host.slice(0, -suffix.length)
}

function openRecordsStep(host: DnsHostDetails | null, zone: string | null): DnsSetupTextPart[] {
  const domain: DnsSetupTextPart[] = zone ? [{ code: zone }] : ["your domain"]
  if (host) return ["Open the DNS records for ", ...domain, ` in ${host.recordsPlace}.`]
  return ["Open the DNS records for ", ...domain, " where you manage your domain."]
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "")
}

/** The user's own pick wins. Else the detected host, else the generic steps. */
export function resolveDnsSetupGuideId(
  choice: DnsSetupGuideId | null,
  detected: DnsHostProvider | null,
): DnsSetupGuideId {
  return choice ?? detected ?? "other"
}
