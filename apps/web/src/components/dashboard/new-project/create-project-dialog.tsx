import { useState, type FormEvent, type ReactNode } from "react"
import { useNavigate } from "@tanstack/react-router"
import type { ExampleDocsTemplate } from "@doxahq/contracts"
import { AlertCircle, Github, Loader2, PenLine, Plus } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription } from "~/components/ui/alert"
import { Badge } from "~/components/ui/badge"
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
import { useCreateExampleProject } from "~/lib/dashboard/use-project-repository"
import { cn } from "~/lib/utils"

/**
 * Names a project without a repository and picks how it starts: the starter
 * docs (the default) or an empty site. The new project opens when it is ready.
 */
export function CreateProjectDialog({
  open,
  onOpenChange,
  onGenerateFromRepository,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Null when the account cannot generate (Free): the footer then has no link to it. */
  onGenerateFromRepository: (() => void) | null
}) {
  const example = useCreateExampleProject()

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && example.isCreating) return
    if (!nextOpen) example.reset()
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl overscroll-contain shadow-none">
        <CreateProjectForm
          example={example}
          onCancel={() => handleOpenChange(false)}
          onGenerateFromRepository={onGenerateFromRepository}
        />
      </DialogContent>
    </Dialog>
  )
}

function CreateProjectForm({
  example,
  onCancel,
  onGenerateFromRepository,
}: {
  example: ReturnType<typeof useCreateExampleProject>
  onCancel: () => void
  onGenerateFromRepository: (() => void) | null
}) {
  const navigate = useNavigate()
  const [name, setName] = useState("")
  const [template, setTemplate] = useState<ExampleDocsTemplate>("starter")
  const trimmedName = name.trim()

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!trimmedName || example.isCreating) return
    try {
      const project = await example.createExampleProject({ name: trimmedName, template })
      toast.success(`Project “${project.name}” created`)
      await navigate({ to: "/dashboard/projects/$projectId/project", params: { projectId: project.id } })
    } catch {
      // The mutation error renders in the dialog.
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)}>
      <DialogHeader>
        <DialogTitle className="text-balance">Create a project</DialogTitle>
        <DialogDescription className="text-pretty">
          Name your docs site and choose how to start. You can change everything later.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="space-y-6">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-project-name">Project name</Label>
          <Input
            id="new-project-name"
            value={name}
            maxLength={120}
            placeholder="My docs"
            autoComplete="off"
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <fieldset className="flex min-w-0 flex-col gap-2.5">
          <legend className="mb-2.5 text-sm font-medium text-foreground">Start from</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <TemplateOption
              value="starter"
              selected={template === "starter"}
              onSelect={setTemplate}
              title="Starter docs"
              badge={<Badge variant="success">Recommended</Badge>}
              description="Example pages that show guides, API reference, cards, tabs and callouts. Edit or delete them as you go."
              sketch={<StarterSketch />}
            />
            <TemplateOption
              value="empty"
              selected={template === "empty"}
              onSelect={setTemplate}
              title="Empty docs"
              description="A blank site with one Introduction page. Write from scratch, or let your agent write it."
              sketch={<EmptySketch />}
            />
          </div>
        </fieldset>

        {example.error ? (
          <Alert variant="destructive" aria-live="polite">
            <AlertCircle aria-hidden="true" />
            <AlertDescription className="break-words">{example.error}</AlertDescription>
          </Alert>
        ) : null}
      </DialogBody>

      <DialogFooter>
        {onGenerateFromRepository ? (
          <Button type="button" variant="ghost" size="sm" className="sm:mr-auto" onClick={onGenerateFromRepository}>
            <Github aria-hidden="true" />
            Generate from a GitHub repository instead
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" disabled={example.isCreating} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!trimmedName || example.isCreating}>
          {example.isCreating ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Plus aria-hidden="true" />}
          {example.isCreating ? "Creating…" : "Create project"}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** One choice of the "Start from" radio group: a small sketch over its name and description. */
function TemplateOption({
  value,
  selected,
  onSelect,
  title,
  badge,
  description,
  sketch,
}: {
  value: ExampleDocsTemplate
  selected: boolean
  onSelect: (value: ExampleDocsTemplate) => void
  title: string
  badge?: ReactNode
  description: string
  sketch: ReactNode
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer flex-col overflow-hidden rounded-lg border transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-1 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
        selected ? "border-primary bg-primary-wash" : "border-border hover:bg-surface-hover",
      )}
    >
      <span aria-hidden="true" className="flex h-28 gap-2 border-b border-divider bg-background p-3.5">
        {sketch}
      </span>
      <span className="flex gap-3 px-4 pt-3.5 pb-4">
        <input
          type="radio"
          name="new-project-template"
          value={value}
          checked={selected}
          onChange={() => onSelect(value)}
          className="mt-0.5 size-4 shrink-0 accent-primary focus-visible:outline-none"
        />
        <span className="flex flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{title}</span>
            {badge}
          </span>
          <span className="text-[13px] leading-5 text-muted-foreground">{description}</span>
        </span>
      </span>
    </label>
  )
}

function SketchSidebar({ rows }: { rows: readonly string[] }) {
  return (
    <span className="flex w-14 shrink-0 flex-col gap-[7px] border-r border-divider pr-2">
      {rows.map((width, index) => (
        <span
          key={index}
          className={cn("h-[5px] rounded-full", index === 1 || rows.length === 1 ? "bg-primary/45" : "bg-border")}
          style={{ width }}
        />
      ))}
    </span>
  )
}

function StarterSketch() {
  return (
    <>
      <SketchSidebar rows={["80%", "95%", "70%", "85%", "60%", "75%"]} />
      <span className="flex flex-1 flex-col gap-[7px]">
        <span className="h-2 w-3/5 rounded-full bg-border-strong" />
        <span className="h-[5px] w-[90%] rounded-full bg-border" />
        <span className="flex flex-1 gap-1.5">
          <span className="flex-1 rounded border border-border bg-surface-hover" />
          <span className="flex-1 rounded border border-border bg-surface-hover" />
        </span>
        <span className="h-3.5 rounded border border-primary/30 bg-primary/12" />
      </span>
    </>
  )
}

function EmptySketch() {
  return (
    <>
      <SketchSidebar rows={["95%"]} />
      <span className="flex flex-1 flex-col gap-[7px]">
        <span className="h-2 w-[45%] rounded-full bg-border-strong" />
        <span className="flex flex-1 items-center justify-center rounded border border-dashed border-border-strong text-label">
          <PenLine className="size-4" />
        </span>
      </span>
    </>
  )
}
