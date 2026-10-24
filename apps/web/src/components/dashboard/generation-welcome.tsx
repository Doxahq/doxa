import type { ReactNode } from "react"
import { FileCode2, Globe2, Loader2, Sparkles, WandSparkles } from "lucide-react"

import { Button } from "~/components/ui/button"
import { cn } from "~/lib/utils"

const GENERATION_STEPS: { icon: ReactNode; title: string; description: string }[] = [
  {
    icon: <FileCode2 aria-hidden="true" />,
    title: "Reads your code",
    description: "AI reads the source code of your connected repository to learn how it works.",
  },
  {
    icon: <WandSparkles aria-hidden="true" />,
    title: "Writes your docs",
    description: "It writes guides, references, and examples, organized into a full docs site.",
  },
  {
    icon: <Globe2 aria-hidden="true" />,
    title: "Publishes a version",
    description: "Each generation creates a hosted docs version that you can publish and share.",
  },
]

/** Centered first-run welcome for projects that have no generations yet. */
export function GenerationWelcome({
  isStarting,
  isGenerating,
  onStart,
  className,
}: {
  isStarting: boolean
  isGenerating: boolean
  /** Null for a role that cannot run generations: the page explains instead. */
  onStart: (() => void) | null
  className?: string
}) {
  const isBusy = isStarting || isGenerating

  return (
    <section
      aria-labelledby="generation-welcome-title"
      className={cn(
        "flex flex-col gap-8 items-center px-6 py-12 text-center surface-card sm:px-10",
        className,
      )}
    >
      <div className="flex flex-col gap-4 items-center">
        <div className="flex flex-col gap-2 max-w-xl">
          <h2
            id="generation-welcome-title"
            className="font-mono text-lg font-bold tracking-[0.08em] text-balance text-foreground uppercase"
          >
            Generate your first docs
          </h2>
          <p className="text-sm leading-6 text-pretty text-muted-foreground">
            A generation is one AI run over your repository. Doxa reads your source code and
            writes complete documentation for it, so you do not start from a blank page.
          </p>
        </div>
      </div>

      <ol className="grid gap-px w-full text-left overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3">
        {GENERATION_STEPS.map((step, index) => (
          <li key={step.title} className="flex flex-col gap-2 p-4 bg-background">
            <div className="flex items-center gap-2 text-muted-foreground [&_svg]:size-4">
              {step.icon}
              <span className="font-mono text-[11px] tracking-[0.14em] uppercase">
                Step {index + 1}
              </span>
            </div>
            <p className="text-sm font-medium text-foreground">{step.title}</p>
            <p className="text-xs leading-5 text-muted-foreground">{step.description}</p>
          </li>
        ))}
      </ol>

      <p className="flex gap-2 items-start max-w-xl text-sm leading-6 text-left text-muted-foreground sm:items-center">
        <span>
          After the run, you can edit any page in the web editor from the{" "}
          <span className="font-mono text-xs tracking-[0.08em] text-foreground uppercase">Content</span>{" "}
          tab.
        </span>
      </p>

      {onStart ? (
        <Button size="lg" onClick={onStart} disabled={isBusy}>
          {isBusy ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <Sparkles aria-hidden="true" />
          )}
          {isStarting ? "Starting…" : isGenerating ? "Generating…" : "Generate docs"}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">A project owner or admin starts generations.</p>
      )}
    </section>
  )
}
