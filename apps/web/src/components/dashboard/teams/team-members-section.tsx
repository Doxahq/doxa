import { useState } from "react"
import { Loader2 } from "lucide-react"
import type { TeamDetail, TeamMember, TeamRole } from "@doxahq/contracts/teams"

import { Select } from "~/components/dashboard/content/site-settings/fields/controls"
import { SectionDescription, SectionLabel } from "~/components/dashboard/dashboard-header"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import {
  TEAM_ROLE_LABELS,
  assignableRoles,
  canChangeMemberRole,
  canRemoveMember,
  formatTeamDate,
} from "~/lib/dashboard/teams-model"

/** The members of a team, with a role picker and a remove action for managers. */
export function TeamMembersSection({
  team,
  viewerUserId,
  changingUserId,
  removingUserId,
  error,
  onChangeRole,
  onRemove,
}: {
  team: TeamDetail
  viewerUserId: string | null
  changingUserId: string | null
  removingUserId: string | null
  error: string | null
  onChangeRole: (userId: string, role: TeamRole) => void
  onRemove: (userId: string) => void
}) {
  const [confirmingUserId, setConfirmingUserId] = useState<string | null>(null)
  const busy = changingUserId !== null || removingUserId !== null

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <SectionLabel>Members</SectionLabel>
        <SectionDescription>
          A member's role applies to every project of the team, and to the agents they connect.
        </SectionDescription>
      </div>
      <ul className="surface-card">
        {team.members.map((member) => (
          <MemberRow
            key={member.userId}
            member={member}
            viewerUserId={viewerUserId}
            viewerRole={team.role}
            disabled={busy}
            isChanging={changingUserId === member.userId}
            isConfirming={confirmingUserId === member.userId}
            isRemoving={removingUserId === member.userId}
            onChangeRole={(role) => onChangeRole(member.userId, role)}
            onAskRemove={() => setConfirmingUserId(member.userId)}
            onCancelRemove={() => setConfirmingUserId(null)}
            onConfirmRemove={() => {
              onRemove(member.userId)
              setConfirmingUserId(null)
            }}
          />
        ))}
      </ul>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </section>
  )
}

function MemberRow({
  member,
  viewerUserId,
  viewerRole,
  disabled,
  isChanging,
  isConfirming,
  isRemoving,
  onChangeRole,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
}: {
  member: TeamMember
  viewerUserId: string | null
  viewerRole: TeamRole
  disabled: boolean
  isChanging: boolean
  isConfirming: boolean
  isRemoving: boolean
  onChangeRole: (role: TeamRole) => void
  onAskRemove: () => void
  onCancelRemove: () => void
  onConfirmRemove: () => void
}) {
  const editable = canChangeMemberRole(viewerRole, member)
  const isViewer = member.userId === viewerUserId
  // The viewer leaves with "Leave team", not from their own row.
  const removable = canRemoveMember(viewerRole, viewerUserId, member)

  return (
    <li className="flex flex-col gap-3 border-t border-divider px-5 py-4 first:border-t-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[14.5px] font-medium text-foreground">
            {member.name}
            {isViewer ? <span className="text-muted-foreground"> (you)</span> : null}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {member.email} · Joined {formatTeamDate(member.joinedAt)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isChanging ? <Loader2 aria-hidden="true" className="size-4 animate-spin text-muted-foreground" /> : null}
          {editable ? (
            <Select
              aria-label={`Role of ${member.name}`}
              className="w-32"
              value={member.role}
              options={roleOptions(viewerRole, member.role)}
              onValueChange={(role) => {
                if (role !== member.role) onChangeRole(role)
              }}
              disabled={disabled}
            />
          ) : (
            <Badge variant="muted">{TEAM_ROLE_LABELS[member.role]}</Badge>
          )}
          {removable && !isConfirming ? (
            <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onAskRemove}>
              Remove
            </Button>
          ) : null}
        </div>
      </div>
      {isConfirming ? (
        <div
          role="group"
          aria-label={`Remove ${member.name}`}
          className="flex flex-col gap-3 border border-destructive/40 bg-destructive/8 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-sm text-foreground">
            Remove {member.name}? They and their agents lose access to the team's projects at once.
          </p>
          <div className="flex shrink-0 gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={isRemoving} onClick={onCancelRemove}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" size="sm" disabled={isRemoving} onClick={onConfirmRemove}>
              Remove member
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

/** The roles the viewer can pick, plus the member's current one so the select shows it. */
function roleOptions(viewerRole: TeamRole, current: TeamRole) {
  const roles = assignableRoles(viewerRole)
  const shown = roles.includes(current) ? roles : [current, ...roles]
  return shown.map((role) => ({ value: role, label: TEAM_ROLE_LABELS[role] }))
}
