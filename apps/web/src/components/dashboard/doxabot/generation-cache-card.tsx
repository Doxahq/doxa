import { useState } from "react"
import { AlertCircle, AlertTriangle, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
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
import { useProjectCapabilities } from "~/lib/dashboard/use-project-capabilities"
import { useProjectGenerationCache } from "~/lib/dashboard/use-project-generation-cache"
import { getErrorMessage } from "~/lib/errors"

/** Doxabot → Generation cache. Clearing it makes the next run rebuild every page, so it reads as a warning. */
export function GenerationCacheCard({ projectId }: { projectId: string }) {
  const state = useProjectGenerationCache(projectId)
  const { can } = useProjectCapabilities(projectId)

  return (
    <>
      {state.error ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" className="size-4" />
          <AlertTitle>Unable to load the generation cache</AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="border-warning/35 bg-warning/8">
        <CardHeader>
          <div className="flex min-w-0 items-start gap-3">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
            <div className="flex min-w-0 flex-col gap-1.5">
              <CardTitle>
                <h3>Generation cache</h3>
              </CardTitle>
              <CardDescription>
                Generations reuse the previous analysis, structure, and pages wherever the source has not changed.
                Clear the cache to make the next generation analyze the repository from scratch. That generation
                rebuilds every page, so it uses more credits than a normal run.
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="flex flex-wrap items-center gap-4">
          {can("generation.run") ? (
            <ClearCacheDialog
              disabled={state.isLoading || state.cache === null}
              isClearing={state.isClearing}
              onClear={state.clear}
            />
          ) : null}
          <p className="font-mono text-xs text-muted-foreground uppercase">
            {state.isLoading
              ? "Loading…"
              : state.cache?.clearedAt
                ? `Last cleared ${new Date(state.cache.clearedAt).toLocaleString()}`
                : "Never cleared"}
          </p>
        </CardContent>
      </Card>
    </>
  )
}

function ClearCacheDialog({
  disabled,
  isClearing,
  onClear,
}: {
  disabled: boolean
  isClearing: boolean
  onClear: () => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)

  async function clear(): Promise<void> {
    try {
      await onClear()
      toast.success("Generation cache cleared")
      setOpen(false)
    } catch (caught) {
      toast.error(getErrorMessage(caught, "Failed to clear the generation cache."))
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && isClearing) return
        setOpen(nextOpen)
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" className="w-fit border-warning/40 text-warning" disabled={disabled}>
          Clear generation cache
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Clear generation cache?</DialogTitle>
          <DialogDescription>
            The next generation will analyze the repository from scratch and rebuild every page.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Your published documentation stays online and unchanged until that generation finishes. Because nothing
            is reused, the next run takes noticeably longer, uses more credits, and the resulting structure may differ
            from the current one.
          </p>
          <p className="text-sm text-muted-foreground">
            Each open pull request will also do one full rebuild the next time it runs, instead of reusing its
            previous preview. Previews that are already published stay online until then.
          </p>
        </DialogBody>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={isClearing}>
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={() => void clear()} disabled={isClearing}>
            {isClearing ? <Loader2 aria-hidden="true" className="mr-2 size-4 animate-spin" /> : null}
            Clear cache
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
