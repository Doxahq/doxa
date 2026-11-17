import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { useNavigate, useRouter } from "@tanstack/react-router"
import { useCommandState } from "cmdk"
import { Check } from "lucide-react"

import {
  commandValue,
  useDashboardCommands,
  type CommandGroupId,
  type DashboardCommand,
} from "~/components/dashboard/command-menu/dashboard-commands"
import { KeyHints } from "~/components/dashboard/shell/menu-parts"
import { ProjectMonogram } from "~/components/dashboard/shell/project-monogram"
import { WorkspaceTile } from "~/components/dashboard/shell/workspace-tile"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "~/components/ui/command"
import { useKeySequences } from "~/lib/dashboard/key-sequence"
import { useProjectsSummary } from "~/lib/dashboard/use-projects-summary"
import { useWorkspace } from "~/lib/dashboard/workspace-context"
import { projectsInWorkspace, workspaceSummary } from "~/lib/dashboard/workspace-model"

interface CommandMenuContextValue {
  open: boolean
  setOpen: (open: boolean) => void
}

const CommandMenuContext = createContext<CommandMenuContextValue | null>(null)

const GROUP_HEADINGS: Record<Exclude<CommandGroupId, "project">, string> = {
  actions: "Commands",
  account: "Account",
  help: "Help",
}

// The menu mounts its rows on each open. They read the cached projects, so an
// open makes no request. Project mutations still refresh the list.
const COMMAND_MENU_PROJECTS = { refetchOnMount: false } as const

export function useCommandMenu(): CommandMenuContextValue {
  const ctx = useContext(CommandMenuContext)
  if (!ctx) throw new Error("useCommandMenu must be used within CommandMenuProvider")
  return ctx
}

/**
 * The "Search or jump to…" menu. ⌘K toggles it. Its groups are the current
 * project's pages, the projects of the current workspace, the other
 * workspaces, the commands, the account and help. The
 * G-then-key shortcuts that it shows work on every dashboard page.
 */
export function CommandMenuProvider({ projectId, children }: { projectId: string | null; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const commands = useDashboardCommands(projectId)

  useKeySequences(
    commands.flatMap(({ sequence, run }) => (sequence ? [{ sequence, run }] : [])),
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  function runCommand(run: () => void) {
    setOpen(false)
    run()
  }

  return (
    <CommandMenuContext.Provider value={{ open, setOpen }}>
      {children}
      <CommandDialog open={open} onOpenChange={setOpen} title="Search or jump to" className="max-w-xl">
        <CommandInput placeholder="Search or jump to…" />
        <CommandList className="max-h-[min(440px,60vh)] scrollbar-subtle">
          <CommandEmpty className="py-8 text-center text-sm text-muted-foreground">No results found.</CommandEmpty>
          <PreloadHighlightedRow commands={commands} />
          <ProjectPagesGroup projectId={projectId} commands={commands} onRun={runCommand} />
          <ProjectsGroup projectId={projectId} onRun={runCommand} />
          <WorkspacesGroup onRun={runCommand} />
          {(Object.keys(GROUP_HEADINGS) as (keyof typeof GROUP_HEADINGS)[]).map((group) => (
            <CommandRows
              key={group}
              heading={GROUP_HEADINGS[group]}
              commands={commands.filter((command) => command.group === group)}
              onRun={runCommand}
            />
          ))}
        </CommandList>
        <KeyHints hints={["↑↓ navigate", "↵ select", "esc close"]} />
      </CommandDialog>
    </CommandMenuContext.Provider>
  )
}

/** The pages of the current project, under the project's name. */
function ProjectPagesGroup({
  projectId,
  commands,
  onRun,
}: {
  projectId: string | null
  commands: readonly DashboardCommand[]
  onRun: (run: () => void) => void
}) {
  const { projects } = useProjectsSummary(COMMAND_MENU_PROJECTS)
  const current = projects.find(({ id }) => id === projectId)
  return (
    <CommandRows
      heading={current?.name ?? "Project"}
      commands={commands.filter((command) => command.group === "project")}
      onRun={onRun}
      separated={false}
    />
  )
}

function CommandRows({
  heading,
  commands,
  onRun,
  separated = true,
}: {
  heading: string
  commands: readonly DashboardCommand[]
  onRun: (run: () => void) => void
  separated?: boolean
}) {
  if (commands.length === 0) return null
  return (
    <>
      {separated ? <CommandSeparator className="bg-divider" /> : null}
      <CommandGroup heading={heading}>
        {commands.map((command) => (
          <CommandItem
            key={command.id}
            value={commandValue(command)}
            keywords={command.keywords ? [...command.keywords] : undefined}
            onSelect={() => onRun(command.run)}
          >
            <command.icon aria-hidden="true" className="text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{command.label}</span>
            <ShortcutKeys keys={command.sequence ?? command.hint} />
          </CommandItem>
        ))}
      </CommandGroup>
    </>
  )
}

/**
 * Preloads the page of the highlighted row (its code and its requests), as a
 * hovered link does, so the page is ready when the row is chosen. The arrow
 * keys and the pointer both move the highlight.
 */
export function PreloadHighlightedRow({ commands }: { commands: readonly DashboardCommand[] }) {
  const router = useRouter()
  const highlighted = useCommandState((state) => state.value)
  const { projects } = useProjectsSummary(COMMAND_MENU_PROJECTS)
  // The rows can change while one stays highlighted. Only a new highlight preloads.
  const rows = useRef({ commands, projects })
  rows.current = { commands, projects }

  useEffect(() => {
    if (!highlighted) return
    const command = rows.current.commands.find((candidate) => commandValue(candidate) === highlighted)
    if (command) {
      command.preload?.()
      return
    }
    const project = rows.current.projects.find((candidate) => projectValue(candidate) === highlighted)
    if (!project) return
    void router
      .preloadRoute({ to: "/dashboard/projects/$projectId", params: { projectId: project.id } })
      .catch(() => undefined)
  }, [highlighted, router])

  return null
}

/** The cmdk value of a project row. */
function projectValue(project: { id: string; name: string; slug: string }): string {
  return `project ${project.name} ${project.slug} ${project.id}`
}

/** The projects of the current workspace, the current one marked. Selecting one opens it. */
function ProjectsGroup({ projectId, onRun }: { projectId: string | null; onRun: (run: () => void) => void }) {
  const navigate = useNavigate()
  const { projects } = useProjectsSummary(COMMAND_MENU_PROJECTS)
  const { current, workspaces } = useWorkspace()
  const workspaceProjects = current ? projectsInWorkspace(projects, current.id) : []
  if (!current || workspaceProjects.length === 0) return null

  return (
    <>
      <CommandSeparator className="bg-divider" />
      <CommandGroup heading={workspaces.length > 1 ? `${current.name} projects` : "Projects"}>
        {workspaceProjects.map((project) => (
          <CommandItem
            key={project.id}
            value={projectValue(project)}
            onSelect={() =>
              onRun(() => void navigate({ to: "/dashboard/projects/$projectId", params: { projectId: project.id } }))
            }
          >
            <ProjectMonogram project={project} className="size-5 rounded-sm text-[10.5px]" />
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
            {project.id === projectId ? <Check aria-label="Current project" className="text-primary-text" /> : null}
          </CommandItem>
        ))}
      </CommandGroup>
    </>
  )
}

/** The other workspaces. Selecting one switches to it, as the logo menu does. */
function WorkspacesGroup({ onRun }: { onRun: (run: () => void) => void }) {
  const { current, workspaces, switchTo } = useWorkspace()
  const others = workspaces.filter((workspace) => workspace.id !== current?.id)
  if (!current || others.length === 0) return null

  return (
    <>
      <CommandSeparator className="bg-divider" />
      <CommandGroup heading="Switch workspace">
        {others.map((workspace) => (
          <CommandItem
            key={workspace.id}
            value={`workspace ${workspace.name} ${workspace.id}`}
            keywords={["switch", "team", "workspace"]}
            onSelect={() => onRun(() => switchTo(workspace.id))}
          >
            <WorkspaceTile workspace={workspace} className="size-5 text-[9px]" />
            <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
            <span className="shrink-0 truncate text-xs text-muted-foreground">{workspaceSummary(workspace)}</span>
          </CommandItem>
        ))}
      </CommandGroup>
    </>
  )
}

/** The keys of a shortcut, one box each. */
function ShortcutKeys({ keys }: { keys: readonly string[] | undefined }) {
  if (!keys) return null
  return (
    <CommandShortcut className="flex gap-1 tracking-normal">
      {keys.map((key, index) => (
        <kbd
          key={index}
          className="grid h-5 min-w-5 place-items-center rounded-sm border border-border px-1 font-mono text-[10.5px] text-muted-foreground uppercase"
        >
          {key}
        </kbd>
      ))}
    </CommandShortcut>
  )
}
