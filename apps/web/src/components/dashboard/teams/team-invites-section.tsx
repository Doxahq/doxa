import { useEffect, useRef, useState, type FormEvent } from "react"
import { useRouterState } from "@tanstack/react-router"
import { Check, Copy, Link2, Loader2, Mail } from "lucide-react"
import type { CreateTeamInviteInput, TeamDetail, TeamInvite, TeamRole } from "@doxahq/contracts/teams"

import { Select } from "~/components/dashboard/content/site-settings/fields/controls"
import { SectionDescription, SectionLabel } from "~/components/dashboard/dashboard-header"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { TEAM_INVITES_ANCHOR, TEAM_ROLE_LABELS, assignableRoles, formatTeamDate } from "~/lib/dashboard/teams-model"

/** How long a copy button shows "Copied". */
const COPIED_FEEDBACK_MS = 2000

/**
 * Invites (spec §5, email spec §10): a manager makes a single-use link with a
 * role, and Doxa emails it when the manager gives an address. Each pending
 * invite lists its link, so a manager can copy it again; only the token hash
 * is stored, and the API derives the link from the invite ID. Opened at
 * `#invites`, it scrolls into view and focuses the email field.
 */
export function TeamInvitesSection({
  team,
  isCreating,
  createError,
  revokingInviteId,
  revokeError,
  onCreate,
  onRevoke,
}: {
  team: TeamDetail
  isCreating: boolean
  createError: string | null
  revokingInviteId: string | null
  revokeError: string | null
  onCreate: (input: CreateTeamInviteInput) => Promise<void>
  onRevoke: (inviteId: string) => void
}) {
  const [role, setRole] = useState<TeamRole>("editor")
  const [email, setEmail] = useState("")
  const sectionRef = useRef<HTMLElement>(null)
  const emailRef = useRef<HTMLInputElement>(null)
  const hash = useRouterState({ select: (state) => state.location.hash })

  useEffect(() => {
    if (hash !== TEAM_INVITES_ANCHOR) return
    sectionRef.current?.scrollIntoView({ block: "start" })
    emailRef.current?.focus({ preventScroll: true })
  }, [hash])
  const roles = assignableRoles(team.role)
  const address = email.trim()

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // The error shows through `createError`; the address stays so the manager can fix it.
    onCreate(address ? { role, email: address } : { role }).then(
      () => setEmail(""),
      () => undefined,
    )
  }

  return (
    <section ref={sectionRef} id={TEAM_INVITES_ANCHOR} className="flex scroll-mt-16 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <SectionLabel>Invites</SectionLabel>
        <SectionDescription>
          Enter an email address to send the invite, or leave it empty and share the link yourself. Each invite works
          once and expires after 7 days.
        </SectionDescription>
      </div>
      <form onSubmit={submit} className="surface-card flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            ref={emailRef}
            type="email"
            aria-label="Email address of the new member"
            placeholder="name@example.com (optional)"
            autoComplete="off"
            value={email}
            maxLength={254}
            onChange={(event) => setEmail(event.target.value)}
            disabled={isCreating}
            className="sm:flex-1"
          />
          <Select
            aria-label="Role of the new member"
            className="sm:w-40"
            value={role}
            options={roles.map((value) => ({ value, label: TEAM_ROLE_LABELS[value] }))}
            onValueChange={setRole}
            disabled={isCreating}
          />
          <Button type="submit" variant="outline" disabled={isCreating}>
            {isCreating ? (
              <Loader2 aria-hidden="true" className="animate-spin" />
            ) : address ? (
              <Mail aria-hidden="true" />
            ) : (
              <Link2 aria-hidden="true" />
            )}
            {address ? "Send invite" : "Create invite link"}
          </Button>
        </div>
        {createError ? <p role="alert" className="text-sm text-destructive">{createError}</p> : null}
      </form>

      {team.invites.length > 0 ? (
        <ul aria-label="Pending invites" className="surface-card">
          {team.invites.map((invite) => (
            <PendingInviteRow
              key={invite.id}
              invite={invite}
              isRevoking={revokingInviteId === invite.id}
              revokeDisabled={revokingInviteId !== null}
              onRevoke={() => onRevoke(invite.id)}
            />
          ))}
        </ul>
      ) : null}
      {revokeError ? <p role="alert" className="text-sm text-destructive">{revokeError}</p> : null}
    </section>
  )
}

function PendingInviteRow({
  invite,
  isRevoking,
  revokeDisabled,
  onRevoke,
}: {
  invite: TeamInvite
  isRevoking: boolean
  revokeDisabled: boolean
  onRevoke: () => void
}) {
  return (
    <li className="flex flex-col gap-3 border-t border-divider px-5 py-3.5 first:border-t-0">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
            <Badge variant="muted">{TEAM_ROLE_LABELS[invite.role]}</Badge>
            <span className="truncate">{invite.email ? `Sent to ${invite.email}` : "Pending invite"}</span>
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {invite.createdBy ? `By ${invite.createdBy.name} · ` : null}
            Expires {formatTeamDate(invite.expiresAt)}
          </span>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={revokeDisabled} onClick={onRevoke}>
          {isRevoking ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
          Revoke
        </Button>
      </div>
      {invite.url ? (
        <div className="flex min-w-0 items-center gap-2">
          <code
            aria-label="Invite link"
            className="min-w-0 flex-1 truncate border border-border bg-background px-2.5 py-1.5 font-mono text-[12.5px] text-muted-foreground"
          >
            {invite.url}
          </code>
          <CopyLinkButton url={invite.url} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Link not available. Revoke it and create a new one.</p>
      )}
    </li>
  )
}

function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
    return () => window.clearTimeout(timer)
  }, [copied])

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  )
}
