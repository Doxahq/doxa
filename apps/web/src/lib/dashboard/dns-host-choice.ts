import { isDnsSetupGuideId, type DnsSetupGuideId } from "~/lib/dashboard/dns-setup-guides"

const STORAGE_KEY_PREFIX = "doxa:dns-host-choice:"

/** The DNS host the user picked for a domain in place of the detected one. */
export function readDnsHostChoice(domainId: string): DnsSetupGuideId | null {
  try {
    const value = localStorage.getItem(storageKey(domainId))
    return value !== null && isDnsSetupGuideId(value) ? value : null
  } catch {
    return null
  }
}

/** Saves the choice, or removes it with `null` to follow the detection again. */
export function writeDnsHostChoice(domainId: string, choice: DnsSetupGuideId | null): void {
  try {
    if (choice === null) localStorage.removeItem(storageKey(domainId))
    else localStorage.setItem(storageKey(domainId), choice)
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function storageKey(domainId: string): string {
  return `${STORAGE_KEY_PREFIX}${domainId}`
}
