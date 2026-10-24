# User Generation Hard Cancel

**Status:** Implemented and verified<br>
**Date:** 2026-07-20<br>
**Scope:** `apps/api` and `apps/web`

## Goal

Let a project owner stop a queued or running generation from its detail page. A
successful cancellation must mark the job `cancelled`, prevent publication, and
request destruction of the job's Cloudflare container.

## Non-Goals

- Cancelling completed, failed, or already-cancelled generations.
- Bulk cancellation or changes to the admin generation controls.
- Pausing the generation queue.
- Retrying, deleting, or restoring a generation.
- Adding a database migration or changing shared DTO shapes.

## User Experience

The generation detail heading shows **Cancel generation** only while the job is
`queued` or `running`. The button uses the destructive treatment and remains easy
to reach on narrow screens without displacing the status information.

Selecting the button opens a confirmation dialog. The dialog states:

> This stops the active generation. No generated documentation from this run will
> be published.

The dialog offers **Keep running** and **Cancel generation**. The destructive
action changes to **Cancelling…** while the request runs. Both actions remain
disabled until the request finishes, which prevents duplicate cancellation
requests.

The dialog closes after success. The page then shows the existing `cancelled`
status, cancellation message, final duration, and terminal generation log. The
button disappears. A failed request keeps the dialog open and shows a concise,
accessible error beside the actions so the user can retry or dismiss it.

The interaction follows Doxa's existing brutalist-dark design system: semantic
color tokens, sharp corners, hairline borders, mono structural labels, sentence-case
button copy, visible focus states, and reduced-motion-safe progress indicators.

## API Design

Add the owner-scoped mutation:

```text
POST /projects/:projectId/generations/:generationId/cancel
```

The route runs through `withUser` and resolves the generation with `userId`,
`projectId`, and `generationId` before changing state. Missing, inaccessible, and
cross-project generations return the same `404` response.

The repository transitions only `queued` or `running` jobs. A successful transition
sets `status = cancelled`, records `Cancelled by user.`, updates `updatedAt`, and
appends a terminal `user_cancel_requested` event with the requesting user ID. A job
that became terminal before the transition returns `409` with a safe message.

After the database transition, the API requests destruction of the per-job agent
container. It appends either `container_destroy_requested` or
`container_destroy_unavailable`, preserving the current admin observability. The
database transition happens first so a cancellation always prevents artifact
publication, even if container destruction is unavailable in a local or degraded
runtime.

The destroy request follows the same transport selection as generation: use the
Cloudflare service binding first, then the configured local agent URL when the
binding is unavailable. The local agent keeps a job-scoped request registry so the
destroy endpoint aborts the active generation and tombstones the job against a
late or repeated delivery. The generation coordinator also checks active state
before opening the container request and while consuming events or heartbeats.

The endpoint returns the refreshed `GenerationJobDto`. The client never supplies a
user ID, project owner ID, container name, or cancellation status.

## Shared Cancellation Boundary

Move container-destruction orchestration out of the admin route and into a focused
API service. Both admin and owner cancellation routes use this service. Admin
authorization stays in the admin route; project ownership stays in the project
route.

Change `JobsRepository.markCancelled` to report whether it transitioned an active
job. This gives the owner route a deterministic answer for terminal-state races and
ensures container destruction runs only after a real transition. Existing worker
and admin callers retain their current behavior.

Queued messages may still reach the worker after cancellation. The worker's
existing active-state transition rejects the cancelled job, acknowledges the
message, and does not start generation. Running jobs receive a container-destroy
request, and the generation coordinator's active-state checks prevent upload and
publication.

## Frontend Data Flow

Add a project-scoped API client function and a TanStack Query mutation to
`useProjectGeneration`. On success, the mutation:

1. Replaces the generation-detail cache with the returned terminal job.
2. Invalidates the generation event query so the cancellation and container events
   appear promptly.
3. Invalidates the project's generation list and project summary so status remains
   consistent across dashboard routes.

The UI does not optimistically mark the job cancelled. It waits for the server so a
network, authorization, or terminal-state error cannot display a false success.
The existing stream or polling path continues to reconcile concurrent changes.

## Accessibility and Interaction Requirements

- Use a button for cancellation and the existing Radix dialog primitives for focus
  trapping, Escape handling, and focus restoration.
- Give the dialog a title and description connected through the primitive's
  accessible semantics.
- Hide decorative icons from assistive technology.
- Announce the inline request error with `aria-live="polite"`.
- Keep visible `focus-visible` treatment on every action.
- Use `motion-safe:animate-spin` for the pending icon.
- Keep the confirmation action specific; do not use generic copy such as Continue.
- Require confirmation because cancellation is destructive and has no undo.

## Error and Race Handling

- `401`: the existing auth boundary handles an expired or missing session.
- `404`: do not reveal whether another user or project owns the generation.
- `409`: explain that the generation already finished and refresh page data.
- Container destroy unavailable: keep the job cancelled, prevent publication, and
  record the infrastructure event for operators.
- Duplicate clicks: disable dialog actions while the mutation is pending.
- Stream wins the race: hide the trigger as soon as the cached generation becomes
  terminal and close any open confirmation dialog.

## Verification

Implementation verification completed on 2026-07-20:

- `pnpm test` passed across the workspace. The final cancellation regression
  suites include 126 API tests, 43 agent-container tests, 31 generation tests,
  and 14 web tests.
- `pnpm typecheck` passed across all 12 participating workspace projects.
- `pnpm build` completed successfully for every participating workspace project.
- A deterministic browser check exercised the confirmation flow at desktop and
  390 px mobile widths without touching a real generation: focus and Escape
  restoration worked, confirmation returned the terminal `cancelled` state, the
  trigger disappeared, the cancellation event appeared, and the console remained
  free of warnings and errors.
- The changed UI follows the current Web Interface Guidelines and the repository's
  `apps/web/DESIGN.md` conventions.

### API Tests

- An authenticated project owner can cancel a queued generation.
- An authenticated project owner can cancel a running generation.
- The route returns `404` for inaccessible and cross-project generations.
- The route returns `409` when the job is already terminal.
- A successful transition requests container destruction and records its result.
- A failed transition does not request container destruction.
- Existing admin cancellation tests still pass through the shared service.

### Web Tests and Checks

- The API client calls the project-scoped endpoint.
- Mutation success updates the detail cache and invalidates related queries.
- Mutation failure produces the dialog's inline error state.
- The trigger appears only for `queued` and `running` jobs.
- The confirmation dialog uses the approved copy and pending state.
- Web and API typechecks pass.
- Focus, keyboard dismissal, loading feedback, narrow layout, and terminal-state
  reconciliation pass a browser check.
- The changed UI files pass the current Web Interface Guidelines review.

## Acceptance Criteria

A project owner can open an active generation, confirm **Cancel generation**, see
the job become `cancelled`, and observe that its container receives a destroy
request. The cancelled job cannot upload or publish generated documentation. Users
cannot cancel another project's generation or any terminal generation. The flow is
keyboard-accessible, responsive, race-safe, and consistent across dashboard caches.
