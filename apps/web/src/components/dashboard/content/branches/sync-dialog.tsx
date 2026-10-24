import { useEffect, useState } from "react"
import type { BranchRef, DocsConflict } from "@doxahq/contracts/docs-branches"
import type { ValidationIssue } from "@doxahq/contracts/validation"

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
import { ConflictDiffView } from "~/components/dashboard/content/branches/conflict-diff-view"
import { ConflictRow } from "~/components/dashboard/content/branches/conflict-row"
import { useSyncBranch } from "~/lib/dashboard/use-sync-branch"
import { useDialogFocusReturn } from "~/lib/dashboard/use-dialog-focus-return"

type BulkResolution = "mine" | "main"

export function SyncDialog(props: {
  projectId: string
  branch: BranchRef
  pages: readonly { href: string; title: string }[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSynchronized?: () => void
}) {
  const [compared, setCompared] = useState<DocsConflict | null>(null)
  const [pendingBulk, setPendingBulk] = useState<BulkResolution | null>(null)
  const focusReturn = useDialogFocusReturn()
  const state = useSyncBranch({
    projectId: props.projectId,
    branch: props.branch,
    open: props.open,
    onSuccess: () => {
      props.onSynchronized?.()
      props.onOpenChange(false)
    },
  })

  useEffect(() => {
    if (props.open) return
    setCompared(null)
    setPendingBulk(null)
  }, [props.open])

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-4xl" {...focusReturn}>
        <DialogHeader>
          <DialogTitle>Synchronize with main</DialogTitle>
          <DialogDescription>
            Apply the latest main changes to this branch before publishing.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="max-h-[65vh] space-y-4 overflow-y-auto">
          {state.isLoading ? <p className="text-sm text-muted-foreground">Loading changes…</p> : null}
          {state.error ? <p className="text-sm text-destructive" role="alert">{state.error}</p> : null}
          {state.issues.length > 0 ? (
            <ul
              className="space-y-1 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
              role="alert"
            >
              {state.issues.map((issue, index) => (
                <li key={`${issue.path}:${issue.code}:${index}`}>
                  {validationIssueMessage(issue, props.pages)}
                </li>
              ))}
            </ul>
          ) : null}

          {state.preview && state.conflicts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {state.preview.autoResolvedCount} automatic{
                ` ${state.preview.autoResolvedCount === 1 ? "update" : "updates"}`
              } will be applied.
            </p>
          ) : null}

          {state.conflicts.length > 0 ? (
            <>
              {pendingBulk ? (
                <BulkConfirmation
                  resolution={pendingBulk}
                  onCancel={() => setPendingBulk(null)}
                  onConfirm={() => {
                    state.setAll(pendingBulk)
                    setPendingBulk(null)
                  }}
                />
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setPendingBulk("main")}>
                    Keep all main (fast sync)
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => setPendingBulk("mine")}>
                    Keep all mine (overwrite main changes)
                  </Button>
                </div>
              )}
              <div className="space-y-3">
                {state.conflicts.map((conflict) => (
                  <div key={conflict.key} className="space-y-2">
                    <ConflictRow
                      conflict={conflict}
                      resolution={state.resolutions[conflict.key]}
                      onResolve={(resolution) => state.setResolution(conflict.key, resolution)}
                      onCompare={() => setCompared((current) => current?.key === conflict.key ? null : conflict)}
                    />
                    {compared?.key === conflict.key ? (
                      <ConflictDiffView
                        projectId={props.projectId}
                        branch={props.branch}
                        conflict={conflict}
                      />
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void state.synchronize()}
            disabled={!state.canSynchronize || state.isSynchronizing}
          >
            {state.isSynchronizing ? "Synchronizing…" : "Synchronize"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BulkConfirmation(props: {
  resolution: BulkResolution
  onCancel: () => void
  onConfirm: () => void
}) {
  const keepingMine = props.resolution === "mine"
  return (
    <div className="rounded-md border border-warning/50 bg-warning/10 p-3">
      <p className="text-sm text-warning">
        {keepingMine
          ? "Keep all of your changes? This overwrites every conflicting change from main."
          : "Keep all main changes? This removes every conflicting change from this branch."}
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={props.onCancel}>Cancel</Button>
        <Button type="button" size="sm" onClick={props.onConfirm}>
          {keepingMine ? "Keep all mine" : "Keep all main"}
        </Button>
      </div>
    </div>
  )
}

function validationIssueMessage(
  issue: ValidationIssue,
  pages: readonly { href: string; title: string }[],
): string {
  if (issue.code !== "structure_missing_page") return issue.message
  const href = issue.params?.href
  const title = typeof href === "string"
    ? pages.find((page) => page.href === href)?.title
    : null
  return title ? `${title}: ${issue.message}` : issue.message
}
