import type { DocsDomainDto } from "@doxahq/contracts"

export function hasReachedCustomDomainLimit(
  domains: DocsDomainDto[],
  customDomainLimit: number,
): boolean {
  const customDomainCount = domains.filter(
    (domain) => domain.kind === "custom_domain",
  ).length

  return customDomainCount >= customDomainLimit
}
