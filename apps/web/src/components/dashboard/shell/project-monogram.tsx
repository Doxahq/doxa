import type { ProjectDto } from "@doxahq/contracts"

import { projectMonogram } from "~/lib/dashboard/project-monogram"
import { cn } from "~/lib/utils"

/** Colored square with the project's initial. */
export function ProjectMonogram({
  project,
  className,
}: {
  project: Pick<ProjectDto, "id" | "name">
  className?: string
}) {
  const { initial, color } = projectMonogram(project)
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-7 shrink-0 place-items-center font-mono text-[12.5px] font-bold text-foreground",
        className,
        // After className: tailwind-merge drops a line height that comes before a font size.
        "leading-none",
      )}
      style={{ backgroundColor: color }}
    >
      {initial}
    </span>
  )
}
