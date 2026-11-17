import { UserAvatar } from "~/components/dashboard/shell/user-avatar"
import { useDashboardAuth } from "~/lib/auth/dashboard-auth-context"
import { projectMonogram } from "~/lib/dashboard/project-monogram"
import { workspaceInitials, type Workspace } from "~/lib/dashboard/workspace-model"
import { cn } from "~/lib/utils"

/**
 * The mark of a workspace: the viewer's avatar for Personal, a square with
 * the team's initials for a team. A team keeps the same fill everywhere.
 */
export function WorkspaceTile({
  workspace,
  className,
}: {
  workspace: Pick<Workspace, "teamId" | "name">
  className?: string
}) {
  if (workspace.teamId === null) return <PersonalTile className={className} />
  const { color } = projectMonogram({ id: workspace.teamId, name: workspace.name })
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-[5px] font-mono text-[10.5px] font-bold text-foreground",
        className,
        "leading-none",
      )}
      style={{ backgroundColor: color }}
    >
      {workspaceInitials(workspace.name)}
    </span>
  )
}

function PersonalTile({ className }: { className?: string }) {
  const { user } = useDashboardAuth()
  const name = user?.name?.trim() || user?.email || ""
  return <UserAvatar image={user?.image} name={name} className={cn("size-7", className)} />
}
