import { useId } from "react"
import { useQuery } from "@tanstack/react-query"

import { ProductionBranchPicker } from "~/components/dashboard/production-branch-picker"
import { Label } from "~/components/ui/label"
import { getErrorMessage } from "~/lib/errors"
import { githubRepositoryBranchesQueryOptions } from "~/lib/queries/dashboard"

/**
 * The production branch of a new project: Doxabot writes the docs from it,
 * and merges into it start the next generations. It starts on the
 * repository's default branch.
 */
export function RepositoryProductionBranchField({
  githubRepositoryId,
  value,
  onValueChange,
  disabled,
}: {
  githubRepositoryId: string
  value: string
  onValueChange: (branch: string) => void
  disabled: boolean
}) {
  const id = useId()
  const branches = useQuery(githubRepositoryBranchesQueryOptions(githubRepositoryId))

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Production branch</Label>
      <ProductionBranchPicker
        id={id}
        label="Production branch"
        value={value}
        branches={branches.data ?? null}
        isLoading={branches.isPending}
        error={branches.error ? getErrorMessage(branches.error, "The branches could not be loaded.") : null}
        onValueChange={onValueChange}
        disabled={disabled}
      />
      <p className="text-[13px] leading-5 text-muted-foreground">
        Doxabot writes your docs from this branch, and merges into it start new generations. You can change it later in
        the Doxabot settings.
      </p>
    </div>
  )
}
