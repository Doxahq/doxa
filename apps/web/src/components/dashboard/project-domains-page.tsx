import { AlertCircle, Globe2, Loader2 } from "lucide-react"

import { DocsDomainCard } from "~/components/dashboard/docs-domain-card"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { DomainRowsSkeleton } from "~/components/dashboard/skeletons/site-settings-skeletons"
import { SkeletonRegion } from "~/components/dashboard/skeletons/skeleton-kit"
import { useProjectCapabilities } from "~/lib/dashboard/use-project-capabilities"
import { useProjectDomains } from "~/lib/dashboard/use-project-domains"

/** Custom domains for the docs site: add, check and remove. Shown in Site settings → Domains. */
export function ProjectDomainsPage({ projectId }: { projectId: string }) {
  const state = useProjectDomains(projectId)
  const canWrite = useProjectCapabilities(projectId).can("domains.write")

  return (
    <div className="surface-card flex flex-col gap-4 p-4">
      {canWrite ? (
        <DomainAddForm state={state} />
      ) : (
        <p className="text-xs leading-5 text-muted-foreground">
          Only a project owner or admin can add, check or remove custom domains.
        </p>
      )}

      {state.error ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      {state.isLoading ? (
        <SkeletonRegion label="Loading domains">
          <DomainRowsSkeleton />
        </SkeletonRegion>
      ) : state.domains.length > 0 ? (
        <div className="flex flex-col gap-3">
          {state.domains.map((domain) => (
            <DocsDomainCard
              key={domain.id}
              domain={domain}
              isChecking={state.refreshingDomainId === domain.id}
              isDeleting={state.deletingDomainId === domain.id}
              onCheck={() => void state.refreshDomain(domain.id)}
              onDelete={() => state.deleteDomain(domain.id)}
              readOnly={!canWrite}
            />
          ))}
        </div>
      ) : (
        <div className="surface-card px-4 py-8 text-center">
          <p className="font-mono text-xs font-bold tracking-[0.14em] text-foreground uppercase">
            No custom domains
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Generated Doxa subdomains work automatically after the first publish.
          </p>
        </div>
      )}
    </div>
  )
}

/** The hostname field and its DNS hint, for a role with `domains.write`. */
function DomainAddForm({ state }: { state: ReturnType<typeof useProjectDomains> }) {
  return (
    <>
        <form
          className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"
          onSubmit={state.addDomain}
        >
          <Input
            value={state.hostname}
            onChange={(event) => state.setHostname(event.currentTarget.value)}
            placeholder="docs.example.com"
            aria-label="Custom domain hostname"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={!state.canAddDomain || state.isCreating}
          />
          <Button
            type="submit"
            disabled={!state.canAddDomain || !state.hostname.trim() || state.isCreating}
          >
            {state.isCreating ? (
              <Loader2 aria-hidden="true" className="animate-spin" />
            ) : (
              <Globe2 aria-hidden="true" />
            )}
            {state.isCreating ? "Adding…" : "Add domain"}
          </Button>
        </form>
        {state.isDomainLimitReached ? (
          <p className="text-xs leading-5 text-muted-foreground">
            Custom domain limit reached. Delete a domain, or{" "}
            <button
              type="button"
              onClick={state.showDomainLimit}
              className="text-foreground underline underline-offset-2 hover:text-primary-text"
            >
              upgrade for more
            </button>
            .
          </p>
        ) : (
          <p className="text-xs leading-5 text-muted-foreground">
            Add the CNAME as DNS only. Doxa starts hostname validation and certificate issuance after it can see the record.
          </p>
        )}
    </>
  )
}
