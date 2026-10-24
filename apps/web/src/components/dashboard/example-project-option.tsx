import { useState, type FormEvent } from "react"
import { BookOpen, Loader2, Plus } from "lucide-react"

import { SectionDescription, SectionLabel } from "~/components/dashboard/dashboard-header"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"

/** New project choice that starts from the example docs site, with no repository. */
export function ExampleProjectOption({
  isCreating,
  error,
  onCreate,
}: {
  isCreating: boolean
  error: string | null
  onCreate: (name: string) => Promise<void>
}) {
  const [name, setName] = useState("")
  const trimmedName = name.trim()

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!trimmedName || isCreating) return
    void onCreate(trimmedName)
  }

  return (
    <section className="surface-card flex flex-col gap-4 p-5">
      <div className="flex items-start gap-3">
        <BookOpen aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="flex flex-col gap-1.5">
          <SectionLabel>Start with example docs</SectionLabel>
          <SectionDescription>
            Get a live docs site with example pages that show each feature. Edit and publish it right away. You can
            connect a GitHub repository later to generate docs with AI.
          </SectionDescription>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="example-project-name">Project name</Label>
          <Input
            id="example-project-name"
            value={name}
            maxLength={120}
            placeholder="My docs"
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={!trimmedName || isCreating}>
          {isCreating ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Plus aria-hidden="true" />}
          {isCreating ? "Creating…" : "Create project"}
        </Button>
      </form>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  )
}
