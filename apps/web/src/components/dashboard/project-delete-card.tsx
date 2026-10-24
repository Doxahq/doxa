import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { AlertCircle, Loader2, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card"
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
import { useDeleteProject } from "~/lib/dashboard/use-delete-project"

interface ProjectDeleteCardProps {
  projectId: string
  projectName: string | null
  projectSlug: string | null
}

export function ProjectDeleteCard({ projectId, projectName, projectSlug }: ProjectDeleteCardProps) {
  const navigate = useNavigate()
  const state = useDeleteProject(projectId)
  const [open, setOpen] = useState(false)
  const [confirmation, setConfirmation] = useState("")
  const confirmed = projectSlug !== null && confirmation.trim() === projectSlug

  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen && state.isDeleting) return
    if (nextOpen) {
      setConfirmation("")
      state.reset()
    }
    setOpen(nextOpen)
  }

  async function confirmDelete(): Promise<void> {
    if (!confirmed || state.isDeleting) return

    try {
      await state.deleteProject()
    } catch {
      // The dialog shows the error and stays open.
      return
    }
    setOpen(false)
    toast.success(`Deleted ${projectName ?? "the project"}`)
    await navigate({ to: "/dashboard" })
    state.forgetProject()
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
              <h3>Delete project</h3>
            </CardTitle>
            <CardDescription className="text-danger/75">
              Permanently delete this project, its documentation, and everything Doxa stores for
              it. This cannot be undone.
            </CardDescription>
          </div>
        </div>

        <Dialog open={open} onOpenChange={handleOpenChange}>
          <DialogTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className="w-fit shrink-0 border-destructive/50 text-danger hover:border-destructive hover:bg-destructive/15 hover:text-danger"
              disabled={projectSlug === null}
            >
              <Trash2 aria-hidden="true" className="mr-2 size-4" />
              Delete project
            </Button>
          </DialogTrigger>

          <DialogContent
            onEscapeKeyDown={(event) => {
              if (state.isDeleting) event.preventDefault()
            }}
            onPointerDownOutside={(event) => {
              if (state.isDeleting) event.preventDefault()
            }}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void confirmDelete()
              }}
            >
              <DialogHeader>
                <DialogTitle className="text-balance">Delete project?</DialogTitle>
                <DialogDescription className="break-all text-pretty">
                  {projectName}
                </DialogDescription>
              </DialogHeader>

              <DialogBody className="flex flex-col gap-4">
                <p className="text-sm leading-6 text-muted-foreground">
                  This permanently deletes the published documentation, every branch and draft,
                  the generation history, and the custom domains of this project. The docs site
                  stops answering within one hour, and Doxa removes the stored files in the
                  background.
                </p>
                <p className="text-sm leading-6 text-foreground">
                  Your GitHub repository does not change.
                </p>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="delete-project-confirmation">
                    Type <span className="font-mono">{projectSlug}</span> to confirm
                  </Label>
                  <Input
                    id="delete-project-confirmation"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={state.isDeleting}
                  />
                </div>

                {state.error ? (
                  <Alert variant="destructive" aria-live="polite">
                    <AlertCircle aria-hidden="true" />
                    <AlertTitle>Could not delete project</AlertTitle>
                    <AlertDescription className="break-words">{state.error}</AlertDescription>
                  </Alert>
                ) : null}
              </DialogBody>

              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="ghost" disabled={state.isDeleting}>
                    Keep project
                  </Button>
                </DialogClose>
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={!confirmed || state.isDeleting}
                >
                  {state.isDeleting ? (
                    <Loader2 aria-hidden="true" className="mr-2 size-4 motion-safe:animate-spin" />
                  ) : (
                    <Trash2 aria-hidden="true" className="mr-2 size-4" />
                  )}
                  {state.isDeleting ? "Deleting…" : "Delete project"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </CardHeader>
    </Card>
  )
}
