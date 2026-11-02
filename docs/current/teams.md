# Teams, roles and invites

## Purpose

A team shares projects with its members (v2 spec §5). A project without a team
is personal and uses the v1 owner policy. Access is checked through one
`ProjectAccessPolicy` for the dashboard, the MCP server and agent actions.

## Access formula

Effective access = role capabilities ∩ grant scope capabilities ∩ grant
project scope. Only the first term depends on teams.

- `MembershipProjectAccessPolicy`
  (`apps/api/src/services/agent-access/membership-project-access-policy.ts`)
  reads the project owner, the project team and the user's role in one query
  (`ProjectAccessRepository`).
- Personal project: the owner (`projects.user_id`) has the `owner` role; anyone
  else gets `not_found`.
- Team project: only the membership counts, also for the project owner. A user
  who is not a member gets `not_found`. A member who leaves loses every
  capability at once.
- A role without the capability: the dashboard gets `forbidden` (403); an
  agent gets `not_found` (spec §12 question 3), so a viewer's agent can read
  and every write tool answers "not found".
- The role table is `ROLE_CAPABILITIES` in `packages/contracts/src/teams.ts`,
  shared with the dashboard:

| Capability | Owner | Admin | Editor | Viewer |
|---|---|---|---|---|
| project.read, docs.read, domains.read, generation.read | ✓ | ✓ | ✓ | ✓ |
| docs.write, site.write, docs.publish, docs.restore, approvals.decide | ✓ | ✓ | ✓ | — |
| generation.run, domains.write, approvals.configure, team.manage, project.create | ✓ | ✓ | — | — |
| project.delete, team.delete | ✓ | — | — | — |

- No OAuth scope grants `approvals.*` or `team.*`.

## Owner-scoped storage

Storage, billing, generation and the GitHub installation stay with the project
owner. The policy returns `ownerUserId`; routes and tools pass it to the
owner-scoped repositories and services, and authorize by membership. The
person who acts is kept where a column records attribution
(`doxabot_automation_settings.updated_by_user_id`, approval `decided_by`,
generation cancel event data). Branch change rows record the owner, as for
agents in v1.

Every dashboard route under `/projects/:projectId` authorizes with
`withProjectAccess(context, capability, handler)` in
`apps/api/src/http/project-access.ts`. `GET /projects/:projectId` also returns
the viewer's `role`. `GET /projects` lists personal and team projects, each
with `team: { id, name } | null`. `/jobs/:jobId` resolves the job's project
and checks `generation.read`.

## Approvals in a team

- Any member with `approvals.decide` can decide. Approving also needs the
  action's own capability: an editor can approve a publish, not a project
  delete or a generation.
- Requests show the member's name (`requestedBy.name`, `decidedBy.name`) and
  the agent.
- `projects.require_other_decider` (default `false`): the member whose agent
  asked cannot approve (403 `other_decider_required`). They can still reject or
  cancel, because that runs nothing. The dashboard detail tells them in
  advance (`viewer.reason`), so Approve is disabled with the reason. It is set on Project settings → Agent
  approvals and recorded in `agent_activity` as
  `{ kind: "require_other_decider", from, to }`.
- A requester who leaves the team: their pending requests go stale in the cron.

## Teams API

| Route | Rule |
|---|---|
| `GET /teams`, `POST /teams` | Any user; the creator becomes the first owner |
| `GET /teams/:teamId` | Members; invites only with `team.manage` |
| `PATCH /teams/:teamId` | `team.manage` (rename) |
| `DELETE /teams/:teamId` | `team.delete`; 409 `team_has_projects` while it has projects |
| `POST /teams/:teamId/invites` | `team.manage`; an `owner` invite needs the owner role; an optional `email` also sends the link by email |
| `DELETE /teams/:teamId/invites/:inviteId` | `team.manage`; revokes a pending invite |
| `PATCH /teams/:teamId/members/:userId` | `team.manage`; only owners give, take or change the owner role |
| `DELETE /teams/:teamId/members/:userId` | Yourself (leave), or `team.manage` |
| `GET /team-invites/:token`, `POST /team-invites/:token/accept` | Signed-in user |
| `PUT /projects/:projectId/team` | Owner of a personal project, into a team where they have `team.manage` |

- At least one owner stays: demoting or removing the last owner answers 409
  `last_owner`. The store locks the team row, so two requests cannot race.
- An invite link holds a token derived from the invite ID:
  `base64url(HMAC-SHA256(BETTER_AUTH_SECRET, "doxa.team-invite.v1:" + id))`,
  43 characters (`HmacInviteTokens` in
  `apps/api/src/services/teams/invite-token.ts`). The service picks the
  invite ID before the insert. Only the SHA-256 hash of the token is stored,
  and preview and accept look the invite up by that hash. Without the secret,
  an invite ID gives no token.
- `GET /teams/:teamId` lists each pending invite with its `url`, so a manager
  can copy the link again. The API derives the token again and checks it
  against the stored hash. An older invite made with a random token gets
  `url: null`. `POST /teams/:teamId/invites` returns `{ invite }` with the
  same `url`.
- Rotating `BETTER_AUTH_SECRET` changes every derived token: pending links
  stop working and list `url: null`. Revoke them and create new ones.
- With `email`, Doxa queues the `team-invite` email with the same link
  (dedupe key `team-invite:<inviteId>`, see [email.md](email.md)). The invite
  stores the address in `team_invites.invited_email` and lists it as
  `email`. A team can send 20 invites by email in one hour
  (`TEAM_INVITE_EMAILS_PER_HOUR`); more answer 429 `invite_email_limit`.
  One person can send 40 invites by email in one hour over all their teams
  (`TEAM_INVITE_EMAILS_PER_SENDER_PER_HOUR`, 429 `invite_sender_limit`), and
  one person sends at most 3 invite emails to one address in one day over
  all their teams (`TEAM_INVITE_EMAILS_PER_RECIPIENT_PER_DAY`, 429
  `invite_recipient_limit`). Invite links without an email have no limit.
  The limits are soft: two requests at the same moment can both pass the
  count.
- One person can own 10 teams (`MAX_OWNED_TEAMS`); creating another answers
  409 `team_limit`.
- A member who still owns a project of the team (`projects.user_id`) cannot
  leave or be removed: 409 `member_owns_projects`. The project runs on the
  owner's GitHub installation and billing, so the owner must stay in the team
  until the project is deleted.
- An invite sent to an email address works only for a signed-in account whose
  verified email is that address (403 `invite_email_mismatch`, also on the
  preview). An invite link without an email works for any account.
- A link works once and expires after 7 days. Failures: 404
  `invite_not_found`, 410 `invite_used` / `invite_expired` / `invite_revoked`,
  409 `already_member` (the link stays unused).
- A project moves into a team only; there is no move back yet. The owner's
  existing agent grants keep working through the owner's team role.

## Dashboard

- `/dashboard/teams` and `/dashboard/teams/$teamId`: teams, members, invite
  links, pending invites, leave, delete. The invite form takes an optional
  email address: with one, the button is "Send invite" and the pending row
  says "Sent to <address>"; without one, "Create invite link" adds the invite
  to the pending list; each pending row shows its link with a Copy button
  (`team-invites-section.tsx`). A revoked invite leaves the list at once, and
  its link with it. A row with `url: null` says "Link not available. Revoke
  it and create a new one."
- The only owner cannot leave: the Leave button is disabled with a note
  (`leaveBlockReason` in `teams-model.ts`). With other members, make one an
  owner first; alone, delete the team. The API refuses with `last_owner`.
- `/invite/$token`: the accept page (no framing, no referrer).
- Project settings: Team card with "Move to team".
- The project switcher, the project list and the consent picker group
  projects by team.
- Role gating: `useProjectCapabilities(projectId)`
  (`apps/web/src/lib/dashboard/use-project-capabilities.ts`) reads `role`
  from `GET /projects/:id` and checks it against `ROLE_CAPABILITIES`. It
  allows nothing until the role loads. The API still enforces every check.
  - `docs.write`: the page editor is read-only without it (Write and Split),
    and the page tree hides its row actions, New section and reordering. The
    branch switcher hides create, rename and erase, and disables Compare with
    a tooltip. Discard, Revert page, Preview URL and the Synchronize banner
    button are hidden.
  - `docs.publish`: the Publish menu is hidden; Merge into main and Promote
    stay visible but disabled, with "Your role in this project does not
    allow this."
  - `docs.restore`: History hides Restore.
  - `site.write`: site settings render inside a disabled fieldset with a
    note; the JSON editor is read-only, logo drop zones are off, Reset to
    published and Restore default settings are hidden.
  - `domains.write`: the add form and each domain's Check again / Delete are
    hidden, with a note (an editor sees the domains only).
  - `generation.run`: Generate docs, Connect repository, Cancel, Delete
    generation (disabled with tooltip), Clear generation cache and the
    Doxabot toggle are hidden.
  - `project.delete`: the Delete card shows for owners only.
  - Approval settings keep the server's `canConfigure`. The preview access
    control is disabled for every role today.

## Data (migration `0030_teams`)

- `teams` (no owner column), `team_members` (primary key team + user, role
  enum `team_role`), `team_invites` (unique `token_hash`, role, `expires_at`,
  `created_by_user_id`, `used_at`, `used_by_user_id`, `revoked_at`).
- `projects.team_id` (nullable, `ON DELETE RESTRICT`) and
  `projects.require_other_decider` (default `false`).

## Known limits

- `delete_branch` matches a branch by the OAuth client and the member that
  created it, so a teammate's agent branch answers `branch_not_found` even
  when both members use the same client.
- An agent's approval requests read as not found once its member leaves the
  team; they come back if the member rejoins with any role.
- Billing per seat is out of scope.

## Related files

- `apps/api/src/services/agent-access/`, `apps/api/src/http/project-access.ts`
- `apps/api/src/services/teams/`, `apps/api/src/repositories/teams.ts`,
  `apps/api/src/routes/teams.ts`
- `packages/contracts/src/teams.ts`
- `apps/web/src/components/dashboard/teams/`, `apps/web/src/lib/dashboard/teams-model.ts`
