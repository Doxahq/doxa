# Agent actions and approvals

## Purpose

An agent that uses the Doxa MCP server can run consequential actions, such as a
publish. Each action goes through one gateway. An approval policy gives each
call one mode: `allow`, `require_approval`, or `deny`. A gated action waits for
a human decision in the dashboard.

The design is in `docs/superpowers/specs/2026-10-04-mcp-server-design.md`,
section 8.

## Actions

| Kind | Default mode | Allowed modes | Review surface |
|---|---|---|---|
| `docs.publish` | `require_approval` | all | publish menu |
| `docs.restore` | `require_approval` | all | approval page |
| `domain.add` | `require_approval` | all | approval page |
| `domain.remove` | `require_approval` | all | approval page |
| `project.create` | `allow` | all | approval page |
| `project.delete` | `require_approval` | `require_approval`, `deny` | approval page |
| `generation.start` | `require_approval` | all | approval page |

Each action is one module in `apps/api/src/services/agent-actions/actions/`.
The module holds the payload schema, the approval rules, the description for
the reviewer, the snapshot of the preconditions, the freshness check, and the
`execute` function.

## Policy

`ApprovalPolicyResolver` asks each policy source in order. The first source
that returns a mode inside the action's `allowedModes` wins. If no source
answers, the action default applies. A mode outside `allowedModes` is ignored
and logged.

The sources, in order (`policy/policy-sources.ts`):

1. `platform_override`: `PlatformOverrideSource` reads the typed list in
   `policy/platform-overrides.ts`, which is empty.
2. `project_setting`: `ProjectSettingSource` reads the project row of
   `agent_action_policies`. It applies to every agent in the project.
   `project.create` has no project, so this source never answers for it.
3. `user_setting`: `UserSettingSource` reads the user row of the user whose
   agent asks. It applies in every project where the project has no setting.
4. `action_default`: the `defaultMode` of the action module.

So a project setting wins over a user setting, and a user setting cannot relax
a project setting (v2 spec §12, question 1). The request row keeps the name of
the source in `policy_source`; the approval request DTO returns it as
`policySource`, and the approval page says why the gate applied.

## Approval settings

A person sets the modes on two dashboard pages:

- Project settings → Agent approvals
  (`/dashboard/projects/$projectId/settings/approvals`): one row for each
  project action, and the default of the erase checkbox of the approve panel
  (`projects.erase_branch_after_publish`, default `true`). Only a user with the
  `approvals.configure` capability can save (owner and admin roles). Others
  see the page read only. The page also sets `require_other_decider`
  (default `false`); see [teams.md](teams.md).
- Account settings → Agent approvals (`/dashboard/settings`): the user's
  defaults, `project.create` included.

Rules (v2 spec §4):

- Each row offers only the action's `allowedModes`. The API refuses other
  modes with 400. `project.delete` never offers Allow.
- A change applies to new requests only. A pending request keeps its mode.
- A change to Allow leaves pending requests pending. A person decides them.
- A change to Block: the cron resolves the policy again for each pending
  request and cancels the ones that now resolve to
  `deny`, with the error `{ code: "blocked", message: "Blocked by a project
  setting." }` (or "a user setting"). Because the cron resolves with the full
  source order, a user Block cancels the user's pending requests in every
  project where no project setting answers first. The Block step reads
  every pending request, 100 per page with a `(createdAt, id)` cursor, and
  resolves each requester, project and action once per run. The freshness
  check stays at the 100 oldest per run.
- Each change that alters a value writes one `agent_activity` row: tool
  `update_approval_settings`, client `dashboard`, and `details` with the old
  and the new value (`{ kind: "approval_mode", scope, actionKind, from, to }`
  or `{ kind: "erase_branch_after_publish", from, to }`).
- The approve panel takes the erase default from
  `GET /projects/:projectId/approval-settings` and waits for it before it
  approves a publish.

## Approve panel diff

- Each changed page in the approve panel shows Added, Edited, or Deleted and
  a Diff button. The list comes from `GET
  /projects/:projectId/branches/:branchRef/diff`, the same
  `DocsBranchDiffService` that the MCP tool `get_branch_diff` reads.
- Diff closes the publish menu, switches the editor to Split, opens the page
  (unless the branch deleted it), and replaces the Split panes with a
  read-only CodeMirror merge view: the source on the branch base (main) on
  the left, the branch source on the right. The sources come from `GET
  /projects/:projectId/branches/:branchRef/diff/page?href=`. "Close diff"
  returns to Split; "Back to request" reopens the approve panel.

## Branch deletion by agents

- `delete_branch` is not an action: a branch is never live, so it has no
  approval gate. It erases a branch only when `docs_branches.created_by_client_id`
  matches the calling OAuth client and `created_by_user_id` matches the member
  behind the connection. Other branches answer `branch_not_found`.
- A branch with a `pending` `docs.publish` request (target key
  `branch:<id>`) is kept. The tool fails with `publish_pending` and
  `details.requestId`; the agent calls `cancel_approval_request`, then retries.
- The dashboard erase is unchanged and may erase any branch of the user.

## Image uploads by agents

- `upload_asset` is not an action either: it writes a branch change, never
  the live site. The image goes live only with an approved `docs.publish` of
  the branch. The approve panel says how many images the publish adds
  ("Adds or replaces N images"), from the `assets` of the branch diff.

## MDX check before a publish

- v2 spec 8.1: a page that fails the MDX check never goes live. The
  `docs.publish` action checks the changed pages of the branch in `capture`
  (`ActionServices.publish.mdxIssues`). With an issue, the action fails with
  `mdx_invalid` and no request starts, whatever the mode. The message names
  each page, its source path, and the line.
- The snapshot pins the branch revision, so an edit after the request makes
  it `stale`. `execute` calls `DocsBranchPublish.publish`, which checks the
  pages again; an approve that hits an issue ends `failed` with the error
  code `mdx_invalid`. An approval request cannot be approved into a broken
  publish.
- The publish menu and the approve panel list the pages with issues
  (`GET /projects/:projectId/content/mdx-issues?branch=`), and Publish stays
  disabled while the list has an entry. See `docs/current/mcp-server.md`
  (MDX check).

## Request lifecycle

```text
pending ──approve──► executing ──► completed
   │                     └───────► failed
   ├──reject───► rejected
   ├──cancel───► cancelled
   ├──expire───► expired
   └──stale────► stale
```

- An approve locks the row and moves it from `pending` to `executing`. A second
  approve fails with `request_not_pending`.
- Before it runs the action, the approve checks the snapshot. If the
  preconditions changed, the request becomes `stale` and nothing runs.
- An allowed action and an approved request run the same `execute` function.
- One target holds one pending request. A repeat by the same agent (same
  member and client) with the same payload and snapshot gets the pending
  request back. Any other request for the target marks the pending one
  `stale` ("replaced") and starts a new one, so an agent never receives a
  request ID that another agent made.
- A pending request expires after 168 hours.
- The API cron (every 5 minutes) expires overdue requests, expires requests of
  removed action kinds, fails requests that stay `executing` for more than 15
  minutes, cancels requests that a setting now blocks, and marks stale
  requests.
- Terminal rows never change.

## Authorization

- The gateway and the approval service use the project access policy
  (`MembershipProjectAccessPolicy`, see [teams.md](teams.md)).
- Any member with `approvals.decide` can decide; approving also needs the
  action's own capability. With `require_other_decider`, the requester cannot
  approve their own agent's request (403 `other_decider_required`) but can
  reject or cancel it.
- One rule decides "may this member approve or reject" (`ApproveEligibility`):
  the approve and reject endpoints enforce it, and the dashboard detail,
  approve, and reject responses (`DashboardApprovalRequest`) carry it as
  `viewer: { canApprove: true, reason: null, canReject: true } | { canApprove:
  false, reason: "other_decider_required" | "missing_capability", canReject:
  boolean }`. Reject needs only `approvals.decide`. The approve panel
  disables Approve and shows the reason, and shows Reject only when
  `canReject` is true (a viewer sees neither decision). The agent DTO
  (`ApprovalRequestDetail`, MCP tools) has no `viewer`.
- Only a dashboard session can approve or reject. The MCP server has no
  approve tool.
- An agent sees and cancels only the requests of its own client, and only
  while its member still has a role on the project (a member who left gets
  `not_found`).
- Any refusal reads as "not found", so a request ID does not reveal another
  user's project.
- `project.delete` needs the typed project name.

## Change recipes

**Make a gated action ungated:** set `approval.defaultMode` to `"allow"` in the
action module.

**Gate an action for one project or one user:** the project admin or the user
sets it on the Agent approvals page. An operator override that no setting can
change goes in `policy/platform-overrides.ts`.

**Add an action:**

1. Add a module in `actions/`.
2. Add it to `ACTION_DEFINITIONS` in `registry.ts` and to `AGENT_ACTION_KINDS`
   in `packages/contracts/src/approval-requests.ts`.
3. Add the MCP tool.

No migration is necessary, because `action_kind` is `text`.

**Remove an action:** remove the tool and the registry entry. The cron expires
pending rows of the removed kind with `action_removed`.

**Add a policy source:** add a class that implements `ApprovalPolicySource`,
add its name to `APPROVAL_POLICY_SOURCES` in
`packages/contracts/src/approval-settings.ts`, and put it in the list in
`policy/policy-sources.ts`.

## Interfaces

- `AgentActionsApi` (service binding, `rpc.ts`): `perform`, `getRequest`,
  `getRequestTask`, `listRequests`, `cancelRequest`. Each method answers with
  `{ ok: true, value }` or `{ ok: false, error: { code, message } }`.
  `getRequestTask` returns `{ request, approvalUrl }`; `doxa-mcp` uses it to
  show a request as an MCP task (see `mcp-server.md`, Protocol).
- `GET /approval-requests/:id`: the lookup for the web link `/approve/<id>`.
- `GET /projects/:projectId/approval-requests?status=`: the newest requests of
  one project, at most one page. The dashboard Requests page
  (`components/dashboard/requests/project-requests-page.tsx`) filters by status
  with this parameter, and by agent (`requestedBy.clientName`) on the loaded
  rows. Only pending rows open the review page.
- `GET /projects/:projectId/approval-requests/:requestId`
- `POST /projects/:projectId/approval-requests/:requestId/approve`: JSON, or
  server-sent publish stages with `Accept: text/event-stream`.
- `POST /projects/:projectId/approval-requests/:requestId/reject`
- `GET /projects/:projectId/approval-settings`: every project action with its
  title, `allowedModes`, `defaultMode`, stored `mode` (or null), and the
  `effectiveMode` and `effectiveSource` for the viewer's agents, plus
  `eraseBranchAfterPublish` and `canConfigure`. Needs `project.read`.
- `PUT /projects/:projectId/approval-settings`: body
  `{ modes?: { "<kind>": mode | null }, eraseBranchAfterPublish? }`. Null
  clears a setting. Needs `approvals.configure` (403 for a member without it,
  404 for anyone else).
- `GET /approval-settings` and `PUT /approval-settings`: the same for the
  signed-in user's defaults, without the erase setting.

## Data

- `agent_approval_requests` (migration `0027`): one row for each gated request.
- `agent_activity` (migration `0026`): one row for each agent write, action,
  decision, or approval setting change. `details` (jsonb, migration `0028`)
  holds the old and the new value of a setting change.
- `agent_action_policies` (migration `0028`): one row for each scope and
  action. `scope_kind` is `project` or `user`; the scope is in `project_id` or
  `user_id` (a check constraint allows exactly one), so a deleted project or
  user takes its rows with it. `mode`, `updated_by_user_id`, `updated_at`.
- `projects.erase_branch_after_publish` (migration `0028`, default `true`).
- `projects.require_other_decider` (migration `0030`, default `false`).
- `docs_publications.agent_client_id`, `agent_client_name`, and
  `approval_request_id`: who published through an agent.

## Related files

- `apps/api/src/services/agent-actions/`
- `apps/api/src/repositories/agent-approval-requests.ts`
- `apps/api/src/repositories/approval-settings.ts`
- `apps/api/src/routes/approval-requests.ts`
- `apps/api/src/routes/approval-settings.ts`
- `packages/contracts/src/approval-requests.ts`
- `packages/contracts/src/approval-settings.ts`
- `apps/web/src/components/dashboard/project-approvals-page.tsx`
- `apps/web/src/components/dashboard/settings/user-approval-settings-section.tsx`
