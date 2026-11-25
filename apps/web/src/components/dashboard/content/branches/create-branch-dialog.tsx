import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { BranchRef, NamedDocsBranch } from "@doxahq/contracts/docs-branches"

import { isApiValidationError } from "~/lib/api-errors"
import { Button } from "~/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { branchNameError } from "~/lib/dashboard/branch-name-validation"
import { useDialogFocusReturn } from "~/lib/dashboard/use-dialog-focus-return"
import { planLimitDetails } from "~/lib/dashboard/billing-model"
import { getErrorMessage } from "~/lib/errors"
import { docsBranchQueryKeys } from "~/lib/queries/docs-branches"
import { createDocsBranch } from "~/lib/docs-branches-api"

interface CreateBranchDialogProps {
  projectId: string
  from: BranchRef
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (branch: NamedDocsBranch) => void
  /** Fills the name field when the dialog opens, for example from the branch search. */
  initialName?: string
}

export function CreateBranchDialog(props: CreateBranchDialogProps) {
  const queryClient = useQueryClient()
  const [name, setName] = useState("")
  const [blurred, setBlurred] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const focusReturn = useDialogFocusReturn()
  const clientError = branchNameError(name)

  useEffect(() => {
    if (props.open) {
      setName(props.initialName ?? "")
      return
    }
    setName("")
    setBlurred(false)
    setServerError(null)
    // The initial name applies once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open])

  const mutation = useMutation({
    mutationFn: () => createDocsBranch(props.projectId, {
      name,
      from: props.from === "main"
        ? { kind: "main" }
        : { kind: "branch", branchId: props.from },
    }),
    onSuccess: async (branch) => {
      await queryClient.invalidateQueries({
        queryKey: docsBranchQueryKeys.list(props.projectId),
      })
      if (branch.kind === "named") props.onCreated(branch)
      props.onOpenChange(false)
    },
    onError: (error) => {
      // A 403 plan_limit opens the plan limit flow (the mutation cache reports it): this dialog makes way.
      if (planLimitDetails(error)) {
        props.onOpenChange(false)
        return
      }
      setServerError(isApiValidationError(error)
        ? (error.issues[0]?.message ?? "The branch name is not valid.")
        : getErrorMessage(error, "The branch could not be created."))
    },
  })

  function submit() {
    setBlurred(true)
    setServerError(null)
    if (clientError) return
    mutation.mutate()
  }

  const visibleError = serverError ?? (blurred ? clientError : null)

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent {...focusReturn}>
        <DialogHeader>
          <DialogTitle>New branch</DialogTitle>
          <DialogDescription>
            Start from {props.from === "main" ? "the current live documentation" : "the selected branch"}.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-2">
          <Label htmlFor="new-branch-name">Branch name</Label>
          <Input
            id="new-branch-name"
            autoFocus
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setServerError(null)
            }}
            onBlur={() => setBlurred(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit()
            }}
            aria-invalid={Boolean(visibleError)}
            aria-describedby={visibleError ? "new-branch-error" : undefined}
          />
          {visibleError ? (
            <p id="new-branch-error" className="text-sm text-destructive" role="alert">
              {visibleError}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending ? "Creating…" : "Create branch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
