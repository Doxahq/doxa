import { useRef } from "react"
import type { ProjectDto } from "@doxahq/contracts"
import { ChevronsUpDown } from "lucide-react"

import { ProjectMonogram } from "~/components/dashboard/shell/project-monogram"
import { ProjectMenuItems } from "~/components/dashboard/shell/sidebar-footer"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "~/components/ui/dropdown-menu"

/**
 * The name above the project's own pages. At rest it reads as a title, larger
 * than a section label. On hover it shows that it is a select, and a click
 * opens the project list.
 */
export function ProjectTitleSelect({
  projectId,
  project,
}: {
  projectId: string
  project: Pick<ProjectDto, "id" | "name"> | null
}) {
  const lastInputWasPointer = useRef(false)

  return (
    <div className="pt-2 pb-0.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={project ? `${project.name}: switch project` : "Switch project"}
            className="group flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-1 text-left text-base leading-7 font-semibold tracking-[-0.01em] text-foreground transition-colors duration-100 ease-out hover:bg-overlay data-[state=open]:bg-overlay"
          >
            {project ? (
              <>
                <ProjectMonogram project={project} className="size-[22px] rounded-md text-[11.5px]" />
                <span className="min-w-0 truncate">{project.name}</span>
              </>
            ) : (
              "Project"
            )}
            <ChevronsUpDown
              aria-hidden="true"
              className="ml-auto size-4 shrink-0 text-faint opacity-0 transition-opacity duration-100 ease-out group-hover:opacity-100 group-data-[state=open]:opacity-100"
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-(--radix-dropdown-menu-trigger-width)"
          onPointerUp={() => {
            lastInputWasPointer.current = true
          }}
          onPointerDownOutside={() => {
            lastInputWasPointer.current = true
          }}
          onKeyDown={() => {
            lastInputWasPointer.current = false
          }}
          // Focus that returns after a mouse action counts as keyboard focus,
          // and its fill would stay on the title. Keyboard users keep the return.
          onCloseAutoFocus={(event) => {
            if (lastInputWasPointer.current) event.preventDefault()
          }}
        >
          <ProjectMenuItems projectId={projectId} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
