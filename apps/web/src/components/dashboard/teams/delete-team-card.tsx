import { useState } from "react"
import { AlertCircle, Loader2, Trash2 } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Card, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"

interface DeleteTeamCardProps {
  teamName: string
  hasProjects: boolean
  isDeleting: boolean
  error: string | null
  /** Rejects when the delete fails; the dialog then shows `error`. */
  deleteTeam: () => Promise<void>
  onDeleted: () => void
  resetError: () => void
}

/**
 * The danger card of the team page. It works like `ProjectDeleteCard`: the
 * button opens a dialog, and the user types the team name to confirm.
 */
export function DeleteTeamCard({
  teamName,
  hasProjects,
  isDeleting,
  error,
  deleteTeam,
  onDeleted,
  resetError,
}: DeleteTeamCardProps) {
  const [open, setOpen] = useState(false)
  const [confirmation, setConfirmation] = useState("")
  const confirmed = confirmation.trim() === teamName

  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen && isDeleting) return
    if (nextOpen) {
      setConfirmation("")
      resetError()
    }
    setOpen(nextOpen)
  }

  async function confirmDelete(): Promise<void> {
    if (!confirmed || isDeleting) return
    try {
      await deleteTeam()
    } catch {
      // The dialog shows the error and stays open.
      return
    }
    setOpen(false)
    onDeleted()
  }

  // `surface-card` sets its own border after the color utilities, so the red
  // border needs `!`.
  return (
    <Card className="border-destructive/40! bg-destructive/5">
      <CardHeader className="gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Trash2 aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
          <div className="flex min-w-0 flex-col gap-1.5">
            <CardTitle className="text-danger">
              <h3>Delete team</h3>
            </CardTitle>
            <CardDescription className="text-danger/75">
              {hasProjects
                ? "A team with projects cannot be deleted. Delete its projects first."
                : "Permanently delete this team, its members and its invite links. This cannot be undone."}
            </CardDescription>
          </div>
        </div>

        <Dialog open={open} onOpenChange={handleOpenChange}>
          <DialogTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className="w-fit shrink-0 border-destructive/50 text-danger hover:border-destructive hover:bg-destructive/15 hover:text-danger"
              disabled={hasProjects}
            >
              <Trash2 aria-hidden="true" className="mr-2 size-4" />
              Delete team
            </Button>
          </DialogTrigger>

          <DialogContent
            onEscapeKeyDown={(event) => {
              if (isDeleting) event.preventDefault()
            }}
            onPointerDownOutside={(event) => {
              if (isDeleting) event.preventDefault()
            }}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void confirmDelete()
              }}
            >
              <DialogHeader>
                <DialogTitle className="text-balance">Delete team?</DialogTitle>
                <DialogDescription className="break-all text-pretty">{teamName}</DialogDescription>
              </DialogHeader>

              <DialogBody className="flex flex-col gap-4">
                <p className="text-sm leading-6 text-muted-foreground">
                  This permanently removes every member and every invite link of this team. Members
                  and their agents lose access to the team at once.
                </p>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="delete-team-confirmation">
                    Type <span className="font-mono">{teamName}</span> to confirm
                  </Label>
                  <Input
                    id="delete-team-confirmation"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={isDeleting}
                  />
                </div>

                {error ? (
                  <Alert variant="destructive" aria-live="polite">
                    <AlertCircle aria-hidden="true" />
                    <AlertTitle>Could not delete team</AlertTitle>
                    <AlertDescription className="break-words">{error}</AlertDescription>
                  </Alert>
                ) : null}
              </DialogBody>

              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="ghost" disabled={isDeleting}>
                    Keep team
                  </Button>
                </DialogClose>
                <Button type="submit" variant="destructive" disabled={!confirmed || isDeleting}>
                  {isDeleting ? (
                    <Loader2 aria-hidden="true" className="mr-2 size-4 motion-safe:animate-spin" />
                  ) : (
                    <Trash2 aria-hidden="true" className="mr-2 size-4" />
                  )}
                  {isDeleting ? "Deleting…" : "Delete team"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </CardHeader>
    </Card>
  )
}
