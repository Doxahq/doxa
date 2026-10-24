import { Link } from "@tanstack/react-router"
import { FileText, Github } from "lucide-react"

import { Button } from "~/components/ui/button"
import { cn } from "~/lib/utils"

/**
 * Shown in place of the generation welcome on a project without a
 * repository: AI generation needs source code to read.
 */
export function ConnectRepositoryWelcome({
  projectId,
  onConnect,
  className,
}: {
  projectId: string
  /** Null for a role that cannot connect a repository; only Explore content stays. */
  onConnect: (() => void) | null
  className?: string
}) {
  return (
    <section
      aria-labelledby="connect-repository-welcome-title"
      className={cn(
        "flex flex-col gap-6 items-center px-6 py-12 text-center surface-card sm:px-10",
        className,
      )}
    >
      <div className="flex flex-col gap-2 max-w-xl">
        <h2
          id="connect-repository-welcome-title"
          className="font-mono text-lg font-bold tracking-[0.08em] text-balance text-foreground uppercase"
        >
          Your example docs are live
        </h2>
        <p className="text-sm leading-6 text-pretty text-muted-foreground">
          This project started with example pages that show what a Doxa site can do. Edit them in the{" "}
          <span className="font-mono text-xs tracking-[0.08em] text-foreground uppercase">Content</span> tab. To
          generate docs from your source code with AI, connect a GitHub repository first.
        </p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button variant="outline" asChild>
          <Link to="/dashboard/projects/$projectId/content" params={{ projectId }}>
            <FileText aria-hidden="true" />
            Explore content
          </Link>
        </Button>
        {onConnect ? (
          <Button onClick={onConnect}>
            <Github aria-hidden="true" />
            Connect repository
          </Button>
        ) : null}
      </div>
    </section>
  )
}
