import type { AgentConsentProject } from "@doxahq/contracts/agent-access"

import { FIELD_LABEL_CLASS } from "~/components/dashboard/dashboard-header"
import { Checkbox } from "~/components/ui/checkbox"
import { groupProjectsByTeam, hasTeamProjects } from "~/lib/dashboard/teams-model"
import type { ProjectChoice } from "~/lib/oauth/consent-model"

const ROW_CLASS = "flex cursor-pointer items-start gap-3 px-3.5 py-3 has-disabled:cursor-default"

/** All projects (also future ones) or a chosen list of projects. */
export function ConsentProjectPicker({
  projects,
  choice,
  issue,
  disabled,
  onChange,
}: {
  projects: readonly AgentConsentProject[]
  choice: ProjectChoice
  issue: string | null
  disabled: boolean
  onChange: (choice: ProjectChoice) => void
}) {
  const selectedIds = choice.kind === "selected" ? choice.projectIds : new Set<string>()
  // Spec §5: with team projects, the list groups by team; personal first.
  const grouped = hasTeamProjects(projects)

  function toggleProject(projectId: string, checked: boolean) {
    const next = new Set(selectedIds)
    if (checked) next.add(projectId)
    else next.delete(projectId)
    onChange({ kind: "selected", projectIds: next })
  }

  return (
    <fieldset className="flex flex-col gap-2.5">
      <legend className={`${FIELD_LABEL_CLASS} mb-2.5`}>Projects</legend>
      <div className="border border-border">
        <label className={ROW_CLASS}>
          <input
            type="radio"
            name="project-scope"
            className="mt-0.5 size-4 shrink-0 accent-primary"
            checked={choice.kind === "all"}
            disabled={disabled}
            onChange={() => onChange({ kind: "all" })}
          />
          <span className="text-sm text-foreground">All projects, including future projects</span>
        </label>
        <label className={`${ROW_CLASS} border-t border-divider`}>
          <input
            type="radio"
            name="project-scope"
            className="mt-0.5 size-4 shrink-0 accent-primary"
            checked={choice.kind === "selected"}
            disabled={disabled || projects.length === 0}
            onChange={() => onChange({ kind: "selected", projectIds: selectedIds })}
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-sm text-foreground">Selected projects</span>
            {projects.length === 0 ? (
              <span className="text-xs text-muted-foreground">You have no projects yet.</span>
            ) : null}
          </span>
        </label>

        {choice.kind === "selected" ? (
          <div className="max-h-56 overflow-y-auto border-t border-divider py-1 scrollbar-subtle">
            {groupProjectsByTeam(projects).map((group) => (
              <ProjectGroup
                key={group.team?.id ?? "personal"}
                heading={grouped ? (group.team?.name ?? "Personal") : null}
                projects={group.projects}
                selectedIds={selectedIds}
                disabled={disabled}
                onToggle={toggleProject}
              />
            ))}
          </div>
        ) : null}
      </div>
      {issue ? <p className="text-xs text-warning">{issue}</p> : null}
    </fieldset>
  )
}

/** One team's projects, under the team name when the list is grouped. */
function ProjectGroup({
  heading,
  projects,
  selectedIds,
  disabled,
  onToggle,
}: {
  heading: string | null
  projects: readonly AgentConsentProject[]
  selectedIds: ReadonlySet<string>
  disabled: boolean
  onToggle: (projectId: string, checked: boolean) => void
}) {
  return (
    <div role={heading ? "group" : undefined} aria-label={heading ?? undefined}>
      {heading ? (
        <p className="pt-2 pr-3.5 pb-1 pl-10 font-mono text-[10.5px] font-medium tracking-[0.14em] text-label uppercase">
          {heading}
        </p>
      ) : null}
      <ul>
        {projects.map((project) => (
          <li key={project.id}>
            <label className="flex cursor-pointer items-center gap-3 py-2 pr-3.5 pl-10 has-disabled:cursor-default">
              <Checkbox
                checked={selectedIds.has(project.id)}
                disabled={disabled}
                onChange={(event) => onToggle(project.id, event.target.checked)}
              />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{project.name}</span>
              <span className="max-w-[40%] shrink-0 truncate font-mono text-[11px] text-muted-foreground">
                {project.slug}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}
