import { Github, Lock } from "lucide-react"
import type { GitHubRepositoryDto } from "@doxahq/contracts"

import { Badge } from "~/components/ui/badge"
import { cn } from "~/lib/utils"

/** One selectable row in a bordered list of GitHub repositories. */
export function RepositoryOption({
  repo,
  existingProject,
  hasDivider,
  isSelected,
  onSelect,
}: {
  repo: GitHubRepositoryDto
  existingProject: { name: string } | null
  hasDivider: boolean
  isSelected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex items-center justify-between gap-3 px-4 py-3 text-left transition-colors",
        hasDivider && "border-t border-border",
        isSelected ? "bg-primary/10" : "hover:bg-accent",
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <Github
          className={cn(
            "size-4 shrink-0",
            isSelected ? "text-primary" : "text-muted-foreground",
          )}
        />
        <span
          className={cn(
            "truncate font-mono text-sm",
            isSelected ? "text-primary" : "text-foreground",
          )}
        >
          {repo.fullName}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {existingProject ? (
          <Badge variant="muted">project exists</Badge>
        ) : null}
        {repo.isPrivate ? (
          <Badge variant="muted">
            <Lock className="size-3" />
            private
          </Badge>
        ) : null}
        <span className="hidden text-xs text-muted-foreground sm:inline">
          {repo.defaultBranch}
        </span>
      </div>
    </button>
  )
}
