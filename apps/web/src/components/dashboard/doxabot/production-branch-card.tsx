import { useId, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { GitBranch, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { ProductionBranchPicker } from "~/components/dashboard/production-branch-picker"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import { useProjectCapabilities } from "~/lib/dashboard/use-project-capabilities"
import { useProjectDoxabot } from "~/lib/dashboard/use-project-doxabot"
import { getErrorMessage } from "~/lib/errors"
import { projectRepositoryBranchesQueryOptions } from "~/lib/queries/dashboard"

/**
 * Doxabot → Production branch: the branch that production generations read,
 * that merges go into, and that pull requests target for a preview. Shown
 * only while the project has a repository.
 */
export function ProductionBranchCard({ projectId }: { projectId: string }) {
  const state = useProjectDoxabot(projectId)
  // Changing the branch changes what the next generation reads.
  const canChange = useProjectCapabilities(projectId).can("generation.run")
  const productionBranch = state.settings?.productionBranch ?? null
  const defaultBranch = state.settings?.repositoryDefaultBranch ?? null
  if (!productionBranch || !defaultBranch) return null

  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 items-start gap-3">
          <GitBranch aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-col gap-1.5">
            <CardTitle>
              <h3 id="doxabot-production-branch">Production branch</h3>
            </CardTitle>
            <CardDescription>
              Doxabot writes your published docs from this branch. Merges into it start new generations, and pull
              requests that target it get previews.
            </CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3 border-t border-border pt-4">
        {canChange ? (
          // Keyed by the saved branch, so the draft starts again after each save.
          <ProductionBranchForm
            key={productionBranch}
            projectId={projectId}
            productionBranch={productionBranch}
            isSaving={state.isSaving}
            onSave={(branch) => state.update({ productionBranch: branch })}
          />
        ) : (
          <p className="flex items-center gap-2 font-mono text-[13px] text-foreground">
            <GitBranch aria-hidden="true" className="size-3.5 text-muted-foreground" />
            {productionBranch}
          </p>
        )}
        <p className="text-[13px] text-muted-foreground">
          {productionBranch === defaultBranch ? (
            "This is the repository's default branch on GitHub."
          ) : (
            <>
              The repository&apos;s default branch on GitHub is{" "}
              <span className="font-mono text-foreground">{defaultBranch}</span>.
            </>
          )}{" "}
          A new branch changes nothing on the live site. The next generation reads it and updates the docs that
          differ.
        </p>
      </CardContent>
    </Card>
  )
}

function ProductionBranchForm({
  projectId,
  productionBranch,
  isSaving,
  onSave,
}: {
  projectId: string
  productionBranch: string
  isSaving: boolean
  onSave: (branch: string) => Promise<unknown>
}) {
  const id = useId()
  const [draft, setDraft] = useState(productionBranch)
  const branches = useQuery(projectRepositoryBranchesQueryOptions(projectId))

  async function save(): Promise<void> {
    try {
      await onSave(draft)
      toast.success("Production branch saved")
    } catch (caught) {
      toast.error(getErrorMessage(caught, "Failed to save the production branch."))
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="min-w-56 flex-1">
        <ProductionBranchPicker
          id={id}
          label="Production branch"
          value={draft}
          branches={branches.data ?? null}
          isLoading={branches.isPending}
          error={branches.error ? getErrorMessage(branches.error, "The branches could not be loaded.") : null}
          onValueChange={setDraft}
          disabled={isSaving}
        />
      </div>
      <Button
        type="button"
        size="sm"
        aria-describedby="doxabot-production-branch"
        disabled={isSaving || draft === productionBranch}
        onClick={() => void save()}
      >
        {isSaving ? <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : null}
        Save branch
      </Button>
    </div>
  )
}
