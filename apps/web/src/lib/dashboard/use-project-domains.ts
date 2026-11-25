import { useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { DocsDomainCollectionDto } from "@doxahq/contracts"
import { toast } from "sonner"

import {
  appendDomain,
  invalidateProjectDomainQueries,
  removeDomain,
  replaceDomain,
} from "~/lib/dashboard/cache"
import { showPlanLimit } from "~/lib/dashboard/billing-denials"
import { planLimitDetails } from "~/lib/dashboard/billing-model"
import { hasReachedCustomDomainLimit } from "~/lib/dashboard/domain-limit"
import { getPendingMutationId } from "~/lib/dashboard/mutation-state"
import { getErrorMessage } from "~/lib/errors"
import { dashboardQueryKeys, docsDomainsQueryOptions } from "~/lib/queries/dashboard"
import {
  createDocsDomain,
  deleteDocsDomain,
  refreshDocsDomain,
} from "~/lib/platform-api"

export function useProjectDomains(projectId: string) {
  const queryClient = useQueryClient()
  const [hostname, setHostname] = useState("")
  const [validationError, setValidationError] = useState<string | null>(null)
  const domainsQuery = useQuery(docsDomainsQueryOptions(projectId))
  const createMutation = useMutation({
    mutationFn: (value: string) => createDocsDomain(projectId, { hostname: value }),
    onSuccess: (domain) => {
      queryClient.setQueryData(
        dashboardQueryKeys.domains(projectId),
        (collection: DocsDomainCollectionDto | undefined) => collection
          ? { ...collection, domains: appendDomain(collection.domains, domain) }
          : collection,
      )
      setHostname("")
    },
    onSettled: () => {
      void invalidateProjectDomainQueries(queryClient, projectId)
    },
  })
  const refreshMutation = useMutation({
    mutationFn: (domainId: string) => refreshDocsDomain(projectId, domainId),
    onSuccess: (domain) => {
      queryClient.setQueryData(
        dashboardQueryKeys.domains(projectId),
        (collection: DocsDomainCollectionDto | undefined) => collection
          ? { ...collection, domains: replaceDomain(collection.domains, domain) }
          : collection,
      )
      toast.success(`Status updated for ${domain.hostname}`)
    },
    onSettled: () => {
      void invalidateProjectDomainQueries(queryClient, projectId)
    },
  })
  const deleteMutation = useMutation({
    mutationFn: async (domainId: string) => {
      await deleteDocsDomain(projectId, domainId)
      return domainId
    },
    onSuccess: (domainId) => {
      queryClient.setQueryData(
        dashboardQueryKeys.domains(projectId),
        (collection: DocsDomainCollectionDto | undefined) => collection
          ? { ...collection, domains: removeDomain(collection.domains, domainId) }
          : collection,
      )
      toast.success("Custom domain deleted")
    },
    onSettled: () => {
      void invalidateProjectDomainQueries(queryClient, projectId)
    },
  })

  async function addDomain(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedHostname = hostname.trim()
    if (!normalizedHostname) {
      setValidationError("Enter a hostname.")
      return
    }
    if (createMutation.isPending || !canAddDomain) return

    setValidationError(null)
    await createMutation.mutateAsync(normalizedHostname).catch(() => undefined)
  }

  async function refreshDomain(domainId: string) {
    if (refreshMutation.isPending || deleteMutation.isPending) return
    setValidationError(null)
    await refreshMutation.mutateAsync(domainId).catch(() => undefined)
  }

  async function deleteDomain(domainId: string): Promise<string | null> {
    if (deleteMutation.isPending || refreshMutation.isPending) {
      return "Another domain change is already in progress."
    }
    setValidationError(null)
    try {
      await deleteMutation.mutateAsync(domainId)
      return null
    } catch (error) {
      return getErrorMessage(error, "Failed to delete docs domain.")
    }
  }

  const errors = [
    validationError,
    domainsQuery.error ? getErrorMessage(domainsQuery.error, "Failed to load docs domains.") : null,
    // The plan limit dialog explains a 403 plan_limit: no second message here.
    createMutation.error && !planLimitDetails(createMutation.error)
      ? getErrorMessage(createMutation.error, "Failed to add docs domain.")
      : null,
    refreshMutation.error ? getErrorMessage(refreshMutation.error, "Failed to refresh docs domain.") : null,
  ]

  const domains = domainsQuery.data?.domains ?? []
  const customDomainLimit = domainsQuery.data?.customDomainLimit ?? 0
  const isDomainLimitReached = domainsQuery.isSuccess
    && hasReachedCustomDomainLimit(domains, customDomainLimit)
  const canAddDomain = domainsQuery.isSuccess && !isDomainLimitReached
  const customDomainCount = domains.filter((domain) => domain.kind === "custom_domain").length

  function showDomainLimit() {
    showPlanLimit("site.custom_domains", customDomainLimit, customDomainCount)
  }

  return {
    domains,
    customDomainLimit,
    canAddDomain,
    isDomainLimitReached,
    showDomainLimit,
    hostname,
    setHostname,
    addDomain,
    refreshDomain,
    deleteDomain,
    isLoading: domainsQuery.isPending,
    isCreating: createMutation.isPending,
    refreshingDomainId: getPendingMutationId(
      refreshMutation.isPending,
      refreshMutation.variables,
    ),
    deletingDomainId: getPendingMutationId(
      deleteMutation.isPending,
      deleteMutation.variables,
    ),
    error: errors.find((message) => message !== null) ?? null,
  }
}
