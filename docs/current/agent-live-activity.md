# Live agent activity

The Agent button in the Content tab shows when an MCP agent works on a project. Its panel shows what the agent did, and which pages it changed.

## Switch

`AGENT_LIVE_ACTIVITY_ENABLED` turns the feature on in both `doxa-api` and `doxa-mcp`. Only the exact value `true` turns it on. When it is off, the routes answer `404`, the Worker writes no events, and the dashboard shows no button.

## Event path

1. A tool call succeeds in the MCP Worker.
2. `describeActivity` on the tool gives one line for each page or action. A tool without it is silent. `apps/mcp/tests/registry.test.ts` lists the silent project tools.
3. `runTool` writes the rows to `agent_live_events` in `waitUntil`. A failed write logs `mcp_live_event_write_failed` and never fails the tool.
4. `GET /projects/:projectId/agent-activity/stream` sends a snapshot, then each new event, then presence. The dashboard falls back to `GET /projects/:projectId/agent-activity` every 5 seconds while the stream is down.

## Stream

The loop reads Postgres, as the generation stream does. It holds no connection between polls, and it works across ECS tasks.

| Rule | Value |
| --- | --- |
| Poll | 1 second for 2 minutes after an event, then 5 seconds |
| Presence message and heartbeat | At most 15 seconds apart |
| Longest stream | 5 minutes. A reconnect checks project access again. |
| Open streams | 5 per user on each ECS task |

Each connection starts with a snapshot, so a reconnect needs no position from the client. The stream closes while the browser tab is hidden.

## Live editing

- `write_page` and `edit_docs` take an optional `note`. The observer `onPagesChanged` of `applyEdits` gives each changed page its line counts and a diff of at most 200 lines and 16,000 characters. A page over the line budget shows in the activity without a diff. `GET /projects/:projectId/agent-activity/:seq/diff` returns one diff.
- An edit event reloads the open page in place through `reloadOpenPage`. Unsaved work stays. The read uses `fetchLatest`, so a newer refresh of the same page does not lose the change mark.
- "Follow the agent" opens each page that the agent edits and scrolls to the change. It turns off when the person opens another page.
- The Write editor tints each block that an agent changed and shows the age of the change, only while the Agent panel is open. The changes stay known while it is closed, so the marks return when it opens. They end when the person leaves the branch or reloads. Split mode has no marks.
- A followed page was not open before the edit, so the editor gets its old text from the stored diff (`revertUnifiedDiff`). A page without a diff opens without marks.
- A click on an edit in the activity list opens its page, on its branch, in Write mode. The editor scrolls to the blocks of that edit and tints them more strongly. The panel shows the diff, which also holds the deleted lines. The editor stops following the agent during a review. Later edits of the same page are undone from their stored diffs to find the blocks. A block that a later edit replaced shows only in the diff.
- The editor is read-only while an agent is active on the open branch.
- On a branch that an agent created, each page save sends `expectedRevision`: the branch revision of the text in the editor, from the same page read (`useTrackPageRevision`). A branch revision moves with every page, so each page load is compared with the editor. The same text takes the new revision. New text replaces a clean editor. New text with unsaved edits keeps the old revision, so the server refuses the save with `409`, and the editor offers the latest version.
- `sync_branch` also reloads the open branch, because a sync changes its pages.
- An edit, branch, or publish event on any branch refreshes the list of branches. So does an event that names a branch that the list does not hold. A branch that is not in the list cannot open: it falls back to `main`. The list also refreshes when the person returns to the tab.
- Page events take their address from the saved change. A new page has its real href, and a rename or move is one event at the new href.

## Rules

- The project of an event comes from the access policy, never from the raw tool input. Action tools are the exception: `doxa-api` authorizes those, and a successful result proves it.
- Agent-written text goes through `cleanAgentText`, and the dashboard shows it as plain text. Live events must never go into a model prompt.
- `seq` orders the rows of one project. A writer takes `pg_advisory_xact_lock` for the project, because a serial ID can commit out of order.
- A cron job deletes rows older than 24 hours. It keeps the newest row of each project without its text, so that `seq` never restarts.
- A project keeps at most 1,000 events. The diffs of one tool call read at most 4,000 source lines, because the diff runs on the Worker after the edit is saved.
- A failed event write logs no stack, because a failed query carries the diff in its message.
- `agent_activity` stays the audit record. It has no read tools and no page content.

## Presence

| State | Rule |
| --- | --- |
| Waiting | The agent has a pending approval request. |
| Active | The last event is less than 60 seconds old. |
| Idle | The last event is 60 seconds to 30 minutes old. |
| Not listed | The last event is more than 30 minutes old. |

The Connected agents list reads `agent_live_events` only while the feature is on, so turning it off removes that dependency. The cron purge always runs, so old diffs expire after the feature is off. Until migration `0045` runs, that one job logs an error each tick.

The browser applies the same rule on the server's clock (`snapshotAt`). The status changes at the exact moment, also while the stream is quiet or down.

The MCP server is stateless, so Doxa cannot know that an agent is connected or finished. The dashboard says "Active" and "Idle", and never "Connected" or "Finished".

## Revoke

`DELETE /projects/:projectId/agent-activity/agents/:grantRef` revokes only a grant of the signed-in member. The snapshot sets `canRevoke` for those grants.

## Deploy order

Run migration `0045`, deploy `doxa-api`, deploy `doxa-mcp`, deploy the web app, then set the switch.
