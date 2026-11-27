import { useState } from "react"
import type { GitHubInstallationDto, GitHubInstallationTransferTargetDto } from "@doxahq/contracts"

import { SectionLabel } from "~/components/dashboard/dashboard-header"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select"
import { REPLAY_MASK_PROPS } from "~/lib/analytics/replay-privacy"
import { useGitHubInstallations } from "~/lib/dashboard/use-github-installations"

/**
 * Account settings → GitHub installations: the installations the user owns,
 * with a move to a member of one of the user's Doxa teams. Shown only when the
 * user owns at least one installation.
 */
export function GitHubInstallationsSection() {
  const { installations, transferTargets, isPending, loadError, transfer, transferringId, transferError } =
    useGitHubInstallations()

  if (isPending || (installations.length === 0 && !loadError)) return null

  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>GitHub installations</SectionLabel>
      {loadError ? (
        <p role="alert" className="surface-card px-5 py-4 text-sm text-destructive">{loadError}</p>
      ) : (
        <ul className="surface-card">
          {installations.map((installation, index) => (
            <InstallationRow
              key={installation.id}
              installation={installation}
              targets={transferTargets}
              isFirst={index === 0}
              isTransferring={transferringId === installation.id}
              disabled={transferringId !== null}
              onTransfer={(userId) => transfer(installation.id, userId).catch(() => undefined)}
            />
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        You own these installations in Doxa. Move one to a member of one of your Doxa teams. Other members
        get access to its projects through the team.
      </p>
      {transferError ? <p role="alert" className="text-sm text-destructive">{transferError}</p> : null}
    </section>
  )
}

function InstallationRow({
  installation,
  targets,
  isFirst,
  isTransferring,
  disabled,
  onTransfer,
}: {
  installation: GitHubInstallationDto
  targets: GitHubInstallationTransferTargetDto[]
  isFirst: boolean
  isTransferring: boolean
  disabled: boolean
  onTransfer: (userId: string) => void
}) {
  const [targetUserId, setTargetUserId] = useState("")
  // A move gives the installation away, so it takes a second click.
  const [isConfirming, setIsConfirming] = useState(false)

  return (
    <li className={`flex flex-wrap items-center justify-between gap-3 px-5 py-4 ${isFirst ? "" : "border-t border-border"}`}>
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="truncate text-sm text-foreground">{installation.accountLogin}</span>
        <Badge variant="muted">{installation.accountType === "Organization" ? "organization" : "user"}</Badge>
        {installation.status !== "active" ? <Badge variant="muted">{installation.status}</Badge> : null}
      </div>
      {targets.length === 0 ? (
        <span className="text-xs text-muted-foreground">Add a team member to move it</span>
      ) : (
        <div className="flex items-center gap-2">
          <Select
            value={targetUserId}
            onValueChange={(next) => {
              setTargetUserId(next)
              setIsConfirming(false)
            }}
            disabled={disabled}
          >
            <SelectTrigger className="h-8 w-56" aria-label={`New owner of ${installation.accountLogin}`}>
              <SelectValue placeholder="Choose a team member" />
            </SelectTrigger>
            <SelectContent>
              {targets.map((target) => (
                <SelectItem key={target.userId} value={target.userId}>
                  {target.name || <span {...REPLAY_MASK_PROPS}>{target.email}</span>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || !targetUserId}
            onClick={() => {
              if (!isConfirming) {
                setIsConfirming(true)
                return
              }
              setIsConfirming(false)
              onTransfer(targetUserId)
            }}
          >
            {isTransferring ? "Moving…" : isConfirming ? "Confirm move" : "Move"}
          </Button>
        </div>
      )}
    </li>
  )
}
