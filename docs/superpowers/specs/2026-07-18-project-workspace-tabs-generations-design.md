# Project Workspace Tabs and Generation History

**Status:** Approved design, pending implementation plan  
**Date:** 2026-07-18  
**Scope:** `apps/web`, `apps/api`, and `packages/contracts`

## Goal

Turn the single-project dashboard into a focused project workspace with explicit,
deep-linkable pages for project details, generation history, generation details,
and domains. Preserve Doxa's brutalist-dark design language while making generation
history useful for production projects.

## Non-Goals

- Redesigning the dashboard shell, sidebar, global header, or status bar.
- Changing generation execution, queues, containers, publishing, or domain lifecycle.
- Adding generation cancellation, filtering, search, or retention controls.
- Adding a database migration.
- Removing the existing `/jobs/:jobId` API routes.

## Route Model

The project workspace uses a shared parent layout and explicit child routes:

```text
/dashboard/projects/:projectId
  -> redirect to /dashboard/projects/:projectId/project

/dashboard/projects/:projectId/project
/dashboard/projects/:projectId/generations
/dashboard/projects/:projectId/generations/:generationId
/dashboard/projects/:projectId/domains
```

`ProjectWorkspaceLayout` owns the project title, back action, Open Docs action,
project-level loading and error states, horizontal navigation, and child `Outlet`.
The Generations link remains active on a generation-detail route.

## Visual and Interaction Design

The workspace keeps the existing Doxa design system:

- True-black canvas, semantic color tokens, sharp corners, and hairline borders.
- JetBrains Mono for structural labels and Inter for readable content.
- Blue text and a blue bottom rule for the active tab; no pills or filled tabs.
- A centered, constrained content column with no floating section cards.
- Horizontal tab overflow on narrow screens without wrapping or clipping labels.
- Visible hover and `focus-visible` states for all interactive elements.

The tabs sit directly below the project title and use Lucide icons:

- Project
- Generations
- Domains

Tabs are router links, so keyboard activation, middle-click, Cmd/Ctrl-click, browser
history, and deep links work without custom event handlers.

### Project Page

The Project page shows only project-level information:

- Publication status
- Slug
- Repository
- Docs target
- Latest generation status and link

Generation controls, event history, and domain management move to their dedicated
pages.

### Generations Page

The page renders generations as one bordered list with row dividers. It does not
use nested cards. Each row is a full-width link and includes:

- Status
- Short generation ID
- Created time
- Duration or live elapsed time
- Published-version state
- Concise failure text when present

The toolbar shows the loaded count and a Generate Docs action. Starting a generation
navigates to its detail page. The page loads 20 generations initially and appends
20 more when the user selects Load More. Existing rows remain visible while the next
page loads.

### Generation Detail Page

The detail page provides:

- Back to Generations navigation
- Status, full generation ID, created and updated times, duration, and docs version
- Progress and current event for queued or running generations
- Failure or cancellation details
- A chronological event log with sequence, source, type, message, timestamp, elapsed
  time, and structured metadata

The job and event queries poll every 2.5 seconds only while the generation is queued
or running. Polling stops for terminal jobs.

### Domains Page

The Domains page preserves the current add, refresh, verification, and disable
flows. It moves the existing domain UI without changing lifecycle behavior.

## API Contract

All new endpoints live under the owned project resource:

```text
GET /projects/:projectId/generations?limit=20&cursor=<opaque>
GET /projects/:projectId/generations/:generationId
GET /projects/:projectId/generations/:generationId/events
```

The list response uses a shared contract:

```ts
interface GenerationsPageDto {
  generations: GenerationJobDto[]
  nextCursor: string | null
}
```

The list orders jobs by `createdAt DESC, id DESC`. The repository reads `limit + 1`
rows, returns at most `limit`, and derives `nextCursor` from the final returned row.
The default limit is 20; the API clamps accepted values to 1 through 50.

The cursor is an opaque base64url-encoded payload containing a strictly validated
ISO timestamp and UUID. Cursor values are query positions, not authorization
claims. A malformed cursor returns `400`. A valid but modified cursor can only move
within the authenticated user's selected project.

The nested detail and event endpoints return the existing `GenerationJobDto` and
`JobEventDto[]` shapes. Existing `/jobs/:jobId` routes remain available for backward
compatibility, but the project workspace does not use them.

## Security Model

Security enforcement lives on the server and in repository queries.

### Authentication and Authorization

- Every endpoint runs through `withUser`.
- List queries constrain both `generation_jobs.project_id` and
  `projects.user_id` through an ownership-scoped join.
- Detail queries constrain user ID, project ID, and generation ID in one repository
  operation.
- Event reads first resolve the generation through the same ownership-scoped detail
  query, then load events by the verified generation ID.
- Missing, inaccessible, and cross-project resources return the same `404` response.
- Client-side project-ID checks may improve UX but never replace server authorization.

This prevents insecure direct object reference access across users and prevents a
generation from appearing beneath the wrong project route.

### Input and Resource Controls

- Parse `limit` and `cursor` with a strict schema.
- Reject malformed cursors with `400`; do not pass unvalidated cursor fields to
  database expressions.
- Cap page size at 50 to limit query and response amplification.
- Use stable keyset pagination instead of offset pagination.
- Select only the generation columns represented by `GenerationJobDto`.
- Keep endpoints read-only. Existing generation mutations remain protected by the
  API's trusted-origin and Fetch Metadata middleware.

### Log and Rendering Safety

- Treat event messages, types, sources, and metadata as untrusted text.
- Render values through React text nodes; never use `dangerouslySetInnerHTML`.
- Do not convert event payload strings into links or executable markup.
- Preserve the generation pipeline's existing secret sanitization before events are
  stored. The UI must never display request credentials, provider keys, or installation
  tokens.
- Bound visible metadata depth and value length to keep hostile or malformed payloads
  from locking the browser. Preserve the complete raw event in the API response for
  future controlled inspection.
- Use `rel="noopener noreferrer"` on external links.

### Error Disclosure

- Return generic `404` responses for inaccessible resources.
- Return a generic malformed-cursor message without echoing cursor contents.
- Do not expose database errors, stack traces, SQL, environment values, or internal
  service credentials in API responses or UI error copy.

## Frontend Architecture

Route modules remain thin and point to focused layout or page components.

```text
components/dashboard/project-workspace-layout.tsx
components/dashboard/project-overview-page.tsx
components/dashboard/project-generations-page.tsx
components/dashboard/project-generation-page.tsx
components/dashboard/project-domains-page.tsx
components/dashboard/project-generation-list.tsx
components/dashboard/project-generation-log.tsx

lib/dashboard/use-project-workspace.ts
lib/dashboard/use-project-generations.ts
lib/dashboard/use-project-generation.ts
lib/dashboard/use-project-domains.ts
lib/dashboard/generation-model.ts

lib/queries/dashboard.ts
```

The exact split may combine very small components, but each module keeps one clear
responsibility. Domain mutation state does not load on Project or Generations pages.
Generation event polling does not run outside a generation detail page.

TanStack Query keys are project-scoped:

```text
dashboard / projects / :projectId
dashboard / projects / :projectId / generations / pages
dashboard / projects / :projectId / generations / :generationId
dashboard / projects / :projectId / generations / :generationId / events
dashboard / projects / :projectId / domains
```

The generation mutation updates or invalidates the project detail, first generation
page, and dashboard summary before navigating to the new generation detail.
Infinite-query page merging deduplicates rows by generation ID.

## Loading, Error, and Empty States

- The project layout owns project-not-found and project-load failures.
- Each page owns only its page-specific loading and error states.
- The Generations empty state includes Generate Docs.
- A running generation with no events shows Waiting for Events rather than an empty
  panel.
- Loading another page keeps existing generations and labels the action Loading….
- Long IDs, repository names, hostnames, messages, and metadata use `min-w-0`,
  truncation, or word breaking as appropriate.
- Dates use `Intl.DateTimeFormat`; durations and numeric columns use tabular numerals.

## Accessibility

- Use links for navigation and buttons for actions.
- Expose the tab row as labeled navigation with `aria-current="page"` on the active
  destination through router link state.
- Preserve visible keyboard focus and sufficient active-state contrast.
- Provide accessible names for icon-only controls and hide decorative icons from
  assistive technology.
- Announce asynchronous generation and pagination failures through existing alert or
  toast primitives.
- Honor reduced-motion preferences for spinners and progress transitions.
- Keep headings hierarchical and page titles unique.

## Verification

### API and Repository Tests

- Authenticated owner can list generations.
- Unauthenticated, wrong-owner, and cross-project requests cannot read list, detail,
  or events.
- Missing and inaccessible resources both return `404`.
- Results use newest-first keyset ordering.
- Equal timestamps use generation ID as a deterministic tie-breaker.
- Cursor continuation has no duplicate or skipped rows.
- Empty and final pages return `nextCursor: null`.
- Limits default to 20 and cannot exceed 50.
- Malformed cursors return `400` without repository access.

### Frontend Verification

- `pnpm --filter @doxahq/web typecheck`
- `pnpm --filter @doxahq/web build`
- `pnpm --filter @doxahq/api test`
- Browser checks at desktop and mobile widths for routes, active tabs, keyboard focus,
  responsive generation rows, pagination, empty states, and generation details.
- Final file-by-file review against the current Web Interface Guidelines.

## Compatibility and Rollout

- No schema migration is required; existing generation and event indexes support the
  first release.
- Existing project URLs redirect to the explicit Project tab.
- Existing `/jobs/:jobId` endpoints remain unchanged.
- The current project-detail implementation stays in place until all child routes are
  wired and verified, then its responsibilities move into focused modules.

## Acceptance Criteria

- Each project tab has a stable explicit URL.
- The old project URL redirects to `/project`.
- Only the active page fetches its specialized data.
- Generations paginate 20 at a time with an opaque cursor.
- Selecting a generation opens a complete, deep-linkable event-log view.
- Active generations update automatically and terminal generations stop polling.
- Server-side ownership checks protect every new list, detail, and event endpoint.
- The UI matches Doxa's existing dashboard theme on desktop and mobile.
- API tests, web typecheck, web build, browser checks, and the interface-guideline
  audit pass.
