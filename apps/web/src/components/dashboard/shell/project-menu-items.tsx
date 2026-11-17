import { Link } from "@tanstack/react-router"
import { Check, Plus } from "lucide-react"

import { MenuSectionLabel } from "~/components/dashboard/shell/menu-parts"
import { ProjectMonogram } from "~/components/dashboard/shell/project-monogram"
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel } from "~/components/ui/dropdown-menu"
import { useProjectsSummary } from "~/lib/dashboard/use-projects-summary"
import { useWorkspace } from "~/lib/dashboard/workspace-context"
import { canCreateProjectIn, projectsInWorkspace } from "~/lib/dashboard/workspace-model"

/**
 * The projects of the current workspace, then "New project" when the role
 * can create one. Other workspaces are one switch away in the logo menu.
 * The list scrolls when it is long.
 */
export function ProjectMenuItems({ projectId }: { projectId: string | null }) {
  const { projects } = useProjectsSummary()
  const { current } = useWorkspace()
  const workspaceProjects = current ? projectsInWorkspace(projects, current.id) : []

  return (
    <>
      <DropdownMenuGroup className="scrollbar-subtle max-h-72 overflow-y-auto">
        <DropdownMenuLabel className="px-2 pt-2 pb-1">
          <MenuSectionLabel>{current ? `${current.name} projects` : "Projects"}</MenuSectionLabel>
        </DropdownMenuLabel>
        {workspaceProjects.map((project) => (
          <DropdownMenuItem key={project.id} asChild>
            <Link to="/dashboard/projects/$projectId" params={{ projectId: project.id }}>
              <ProjectMonogram project={project} className="size-5 rounded-sm text-[10.5px]" />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              {project.id === projectId ? (
                <Check aria-label="Current project" className="ml-auto text-primary-text" />
              ) : null}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuGroup>
      {current && canCreateProjectIn(current) ? (
        <DropdownMenuItem asChild>
          <Link to="/dashboard/projects/new" className="text-muted-foreground">
            <span className="grid size-5 place-items-center rounded-sm border border-dashed border-border">
              <Plus aria-hidden="true" className="size-3" />
            </span>
            New project
          </Link>
        </DropdownMenuItem>
      ) : null}
    </>
  )
}
