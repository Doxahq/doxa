import { Github, Plus } from "lucide-react"

import { Bar, TextBar } from "~/components/dashboard/skeletons/skeleton-kit"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import type { AiGenerationAccess } from "~/lib/dashboard/ai-access"

const STEPS = [
  {
    kicker: "01 · Create",
    title: "Pick how to start",
    description: "Generate from your repository, use starter docs, or start empty.",
  },
  {
    kicker: "02 · Write",
    title: "Edit your pages",
    description: "Write in the editor, or let your agent write and review.",
  },
  {
    kicker: "03 · Publish",
    title: "Go live",
    description: "Publish to your doxa.page address, then add your domain.",
  },
] as const

/**
 * The start of the new project page: the two ways to create a project, and
 * the three steps from a project to a live site. With no project yet, it reads
 * as the empty state of the account.
 *
 * `access` says whether the account can generate. A Free account (no AI)
 * sees the same buttons, with a PRO tag on "Generate from a repository"; the
 * page opens the Pro trial dialog, which says why, when it is clicked. While the plan loads,
 * bars hold the same space, so nothing moves when it arrives.
 */
export function StartProjectCard({
  isFirstProject,
  access,
  onGenerateFromRepository,
  onCreateProject,
}: {
  isFirstProject: boolean
  access: AiGenerationAccess
  onGenerateFromRepository: () => void
  onCreateProject: () => void
}) {
  return (
    <section aria-labelledby="start-project-title" className="surface-card flex flex-col overflow-hidden">
      <div className="flex flex-col items-center gap-5 px-6 pt-12 pb-10 text-center sm:px-8">
        <SiteSketch />
        <div className="flex flex-col items-center gap-2">
          <h2
            id="start-project-title"
            className="font-mono text-sm font-bold tracking-[0.12em] text-foreground uppercase"
          >
            {isFirstProject ? "No projects yet" : "Start a new docs site"}
          </h2>
          <StartDescription access={access} />
        </div>
        <StartActions access={access} onGenerateFromRepository={onGenerateFromRepository} onCreateProject={onCreateProject} />
      </div>

      <ol className="grid border-t border-divider sm:grid-cols-3">
        {STEPS.map((step, index) => (
          <li
            key={step.kicker}
            className={
              index > 0 ? "flex flex-col gap-1.5 border-t border-divider px-6 py-5 sm:border-t-0 sm:border-l" : "flex flex-col gap-1.5 px-6 py-5"
            }
          >
            <span className="font-mono text-[11px] tracking-[0.14em] text-label uppercase">{step.kicker}</span>
            <span className="text-sm font-semibold text-foreground">{step.title}</span>
            <span className="text-[13px] leading-5 text-muted-foreground">{step.description}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

const DESCRIPTION_CLASS = "max-w-[460px] text-sm leading-[22px] text-muted-foreground"

function StartDescription({ access }: { access: AiGenerationAccess }) {
  if (access.kind === "loading") {
    return (
      <div aria-hidden="true" className="w-[440px] max-w-full">
        <TextBar width="100%" className={DESCRIPTION_CLASS} />
        <TextBar width="70%" className={DESCRIPTION_CLASS} />
      </div>
    )
  }
  return (
    <p className={DESCRIPTION_CLASS}>
      Have code on GitHub? Doxabot reads your repository and writes your first docs. Or start from the starter docs or an
      empty site.
    </p>
  )
}

function StartActions({
  access,
  onGenerateFromRepository,
  onCreateProject,
}: {
  access: AiGenerationAccess
  onGenerateFromRepository: () => void
  onCreateProject: () => void
}) {
  if (access.kind === "loading") {
    // The buttons' boxes, so the loaded actions take the same space.
    return (
      <div aria-hidden="true" className="flex flex-wrap justify-center gap-2">
        <Bar width="13.5rem" height="2.25rem" />
        <Bar width="9.25rem" height="2.25rem" />
      </div>
    )
  }
  return (
    <div className="flex flex-wrap justify-center gap-2">
      <Button type="button" onClick={onGenerateFromRepository}>
        <Github aria-hidden="true" />
        Generate from a repository
        {/* The dialog says why; the tag only marks the plan, so it stays out of the button's name. */}
        {access.kind === "needs_pro" ? (
          <Badge aria-hidden="true" className="px-1.5 py-0 leading-4">
            Pro
          </Badge>
        ) : null}
      </Button>
      <Button type="button" variant="outline" onClick={onCreateProject}>
        <Plus aria-hidden="true" />
        Create project
      </Button>
    </div>
  )
}

/** A small drawing of a docs site with a blank page to fill. */
function SiteSketch() {
  return (
    <div aria-hidden="true" className="flex h-[156px] w-[300px] max-w-full overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex w-[78px] shrink-0 flex-col gap-[9px] border-r border-divider px-3 py-4">
        <span className="h-1.5 w-[70%] rounded-full bg-border-strong" />
        <span className="h-1.5 w-[90%] rounded-full bg-primary/45" />
        <span className="h-1.5 w-[60%] rounded-full bg-border" />
        <span className="h-1.5 w-[80%] rounded-full bg-border" />
        <span className="h-1.5 w-1/2 rounded-full bg-border" />
      </div>
      <div className="flex flex-1 flex-col gap-[9px] p-[18px]">
        <span className="h-2.5 w-[55%] rounded-full bg-border-strong" />
        <span className="h-1.5 w-[92%] rounded-full bg-border" />
        <span className="h-1.5 w-[80%] rounded-full bg-border" />
        <span className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border-strong text-label">
          <Plus className="size-[18px]" strokeWidth={1.75} />
        </span>
      </div>
    </div>
  )
}
