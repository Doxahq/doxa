import { useCallback, useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { DnsHostProvider, DocsDomainDnsHost, DocsDomainDto } from "@doxahq/contracts"

import { readDnsHostChoice, writeDnsHostChoice } from "~/lib/dashboard/dns-host-choice"
import {
  buildDnsSetupGuide,
  resolveDnsSetupGuideId,
  type DnsSetupGuide,
  type DnsSetupGuideId,
} from "~/lib/dashboard/dns-setup-guides"
import { docsDomainDnsHostQueryOptions } from "~/lib/queries/dashboard"

export type DnsSetupGuideState =
  | { status: "detecting" }
  | {
      status: "ready"
      /** The host from the nameserver lookup, or null when it is not recognized. */
      detected: DnsHostProvider | null
      nameservers: readonly string[]
      /** The zone that holds the hostname, when the lookup found one. */
      zone: string | null
      guide: DnsSetupGuide
      choose: (id: DnsSetupGuideId) => void
    }

interface StoredChoice {
  domainId: string
  choice: DnsSetupGuideId | null
}

/** A failed lookup shows the generic steps, the same as an unknown host. */
const UNDETECTED: DocsDomainDnsHost = { provider: null, zone: null, nameservers: [] }

/** The DNS setup steps for a custom domain: detected host first, user's pick on top. */
export function useDnsSetupGuide(domain: Pick<DocsDomainDto, "id" | "projectId">): DnsSetupGuideState {
  const query = useQuery(docsDomainDnsHostQueryOptions(domain.projectId, domain.id))
  // Browser storage is read after mount, so the server render and the first
  // client render agree. The lookup is still pending at that point anyway.
  const [stored, setStored] = useState<StoredChoice | null>(null)

  useEffect(() => {
    setStored({ domainId: domain.id, choice: readDnsHostChoice(domain.id) })
  }, [domain.id])

  const dnsHost = query.data ?? UNDETECTED
  const detected = dnsHost.provider

  const choose = useCallback((id: DnsSetupGuideId) => {
    // Picking the detected host clears the override, so a later lookup leads again.
    const choice = id === detected ? null : id
    writeDnsHostChoice(domain.id, choice)
    setStored({ domainId: domain.id, choice })
  }, [detected, domain.id])

  if (query.isPending || stored?.domainId !== domain.id) return { status: "detecting" }

  const guideId = resolveDnsSetupGuideId(stored.choice, detected)
  return {
    status: "ready",
    detected,
    nameservers: dnsHost.nameservers,
    zone: dnsHost.zone,
    guide: buildDnsSetupGuide(guideId, dnsHost.zone),
    choose,
  }
}
