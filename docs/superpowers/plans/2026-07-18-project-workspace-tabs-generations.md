# Project Workspace Tabs and Generations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the project dashboard into explicit Project, Generations, and Domains routes with secure cursor-paginated generation history and a complete generation-event detail view.

**Architecture:** A shared TanStack Router project layout renders the title, actions, route-linked tabs, and child outlet. New project-scoped API routes enforce ownership for generation pages, details, and events; TanStack Query modules keep each page's data and polling isolated.

**Tech Stack:** TypeScript 5.9, React 19, TanStack Router 1.93, TanStack Query 5, Hono, Drizzle ORM, Zod 4, Vitest, Tailwind CSS 4, Lucide React.

## Global Constraints

- Preserve the existing brutalist-dark Doxa design system and semantic Tailwind tokens.
- Use explicit URLs for Project, Generations, Domains, and generation detail.
- Default generation page size is 20; maximum accepted size is 50.
- Enforce authentication and user/project/generation ownership on the server.
- Return uniform `404` responses for missing and inaccessible resources.
- Render event content as untrusted text; never use `dangerouslySetInnerHTML`.
- Keep existing `/jobs/:jobId` routes backward compatible.
- Add no database migration and no remote-service test dependency.
- Do not commit without separate user approval.

---

### Task 1: Pagination Contracts and Cursor Validation

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/utils/generation-pagination.ts`
- Create: `apps/api/tests/utils/generation-pagination.test.ts`

**Interfaces:**
- Produces: `generationsPageSchema`, `GenerationsPageDto`
- Produces: `parseGenerationPageRequest(url: URL): GenerationPageRequestResult`
- Produces: `encodeGenerationCursor(position: GenerationCursorPosition): string`
- Produces: `GenerationCursorPosition = { createdAt: Date; id: string }`

- [ ] **Step 1: Write failing cursor tests**

Cover default limit 20, limit clamp at 50, malformed cursor rejection, and cursor round-trip:

```ts
expect(parseGenerationPageRequest(new URL("https://api.doxa.so/projects/p/generations")))
  .toEqual({ ok: true, value: { limit: 20, cursor: null } })

expect(parseGenerationPageRequest(new URL("https://api.doxa.so/projects/p/generations?limit=200")))
  .toEqual({ ok: true, value: { limit: 50, cursor: null } })

expect(parseGenerationPageRequest(new URL("https://api.doxa.so/projects/p/generations?cursor=bad")))
  .toEqual({ ok: false, message: "Invalid generation cursor." })
```

- [ ] **Step 2: Verify the tests fail for the missing module**

Run: `pnpm --filter @doxahq/api test -- generation-pagination.test.ts`  
Expected: FAIL because `generation-pagination.ts` does not exist.

- [ ] **Step 3: Implement strict cursor parsing**

Use a private Zod schema with `z.iso.datetime()` and `z.string().uuid()`. Decode
base64url JSON inside `try/catch`, validate before constructing a `Date`, and return
a discriminated result instead of throwing. Parse integer limits and clamp them to
`1..50`; reject non-integer values.

- [ ] **Step 4: Add the shared response contract**

```ts
export const generationsPageSchema = z.object({
  generations: z.array(generationJobSchema),
  nextCursor: z.string().nullable(),
})

export type GenerationsPageDto = z.infer<typeof generationsPageSchema>
```

- [ ] **Step 5: Run focused tests and contract typecheck**

Run: `pnpm --filter @doxahq/api test -- generation-pagination.test.ts`  
Expected: PASS.

Run: `pnpm --filter @doxahq/contracts typecheck`  
Expected: exit 0.

- [ ] **Step 6: Review checkpoint**

Inspect the diff for cursor data used as query position only. Commit remains deferred.

---

### Task 2: Secure Project-Scoped Generation API

**Files:**
- Modify: `apps/api/src/repositories/jobs.ts`
- Modify: `apps/api/src/routes/projects.ts`
- Modify: `apps/api/tests/http/projects.test.ts`

**Interfaces:**
- Consumes: `GenerationCursorPosition`, `GenerationsPageDto`, `encodeGenerationCursor`
- Produces: `JobsRepository.listForProject(input)`
- Produces: `JobsRepository.getForProject(input)`
- Produces endpoints:
  - `GET /projects/:projectId/generations`
  - `GET /projects/:projectId/generations/:generationId`
  - `GET /projects/:projectId/generations/:generationId/events`

- [ ] **Step 1: Extend route mocks and write failing authorization tests**

Add mocked repository methods `listForProject`, `getForProject`, and `listEvents`.
Test owner success, inaccessible project `404`, cross-project generation `404`,
malformed cursor `400` without repository access, and scoped event success.

```ts
expect(mocks.jobsRepository.getForProject).toHaveBeenCalledWith({
  userId: "user-1",
  projectId: "project-1",
  jobId: "job-1",
})
```

- [ ] **Step 2: Verify the route tests fail**

Run: `pnpm --filter @doxahq/api test -- projects.test.ts`  
Expected: FAIL because the generation routes and repository methods are missing.

- [ ] **Step 3: Implement ownership-scoped repository methods**

`listForProject` must join `generation_jobs` to `projects` and constrain
`projects.userId`, `generationJobs.projectId`, and the keyset cursor in the same query.
Order by `createdAt DESC, id DESC`, fetch `limit + 1`, and derive `nextCursor` from
the final returned row.

`getForProject` must constrain user ID, project ID, and generation ID in one joined
query. It returns `GenerationJobDto | null`.

- [ ] **Step 4: Add project-scoped routes before `/:projectId`**

Parse list query parameters before repository access. Use `withUser` for every route.
Resolve detail through `getForProject` before reading events. Return `notFound()` for
all inaccessible resource combinations and `error("Invalid generation cursor.", 400)`
for malformed cursors.

- [ ] **Step 5: Run API tests and typecheck**

Run: `pnpm --filter @doxahq/api test -- projects.test.ts generation-pagination.test.ts`  
Expected: PASS.

Run: `pnpm --filter @doxahq/api typecheck`  
Expected: exit 0.

- [ ] **Step 6: Review checkpoint**

Confirm no new route reads a generation by ID without user and project scope. Commit
remains deferred.

---

### Task 3: Web API, Query Keys, and Generation Models

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/tsconfig.json`
- Modify: `apps/web/src/lib/platform-api.ts`
- Modify: `apps/web/src/lib/queries/dashboard.ts`
- Create: `apps/web/src/lib/dashboard/generation-model.ts`
- Create: `apps/web/tests/generation-model.test.ts`

**Interfaces:**
- Produces: `listProjectGenerations(projectId, pageParam)`
- Produces: `getProjectGeneration(projectId, generationId)`
- Produces: `listProjectGenerationEvents(projectId, generationId)`
- Produces: project-scoped finite and infinite query option factories
- Produces: date, duration, status, metadata, and deduplication helpers

- [ ] **Step 1: Add Vitest to the web package and write failing model tests**

Match the repository's Vitest version, change `test` to `vitest run`, and include
`tests` in the web tsconfig. Tests cover stable deduplication, terminal duration,
live elapsed duration, safe metadata projection, and long-value truncation.

```ts
expect(dedupeGenerations([[newer, duplicate], [duplicate, older]]))
  .toEqual([newer, duplicate, older])
```

- [ ] **Step 2: Verify the model tests fail**

Run: `pnpm --filter @doxahq/web test -- generation-model.test.ts`  
Expected: FAIL because `generation-model.ts` does not exist.

- [ ] **Step 3: Implement typed platform API methods**

Use `URLSearchParams` for `limit` and optional cursor. Call only project-scoped routes.
Type responses with `GenerationsPageDto`, `GenerationJobDto`, and `JobEventDto[]`.

- [ ] **Step 4: Add project-scoped query keys and options**

```ts
generations: (projectId: string) =>
  [...dashboardQueryKeys.project(projectId), "generations"] as const,
generation: (projectId: string, generationId: string) =>
  [...dashboardQueryKeys.generations(projectId), generationId] as const,
generationEvents: (projectId: string, generationId: string) =>
  [...dashboardQueryKeys.generation(projectId, generationId), "events"] as const,
```

The infinite query uses `initialPageParam: null` and returns `lastPage.nextCursor` from
`getNextPageParam`.

- [ ] **Step 5: Implement pure generation-model helpers**

Use `Intl.DateTimeFormat` for timestamps, tabular numeric-ready duration strings, a
status-to-badge mapping, ID shortening, stable deduplication, and bounded event metadata
projection. Metadata projection recursively converts primitives and shallow arrays or
objects to readable text, limits visible entries and characters, and never produces
HTML.

- [ ] **Step 6: Run tests, typecheck, and lockfile update**

Run: `pnpm install --lockfile-only`  
Expected: lockfile records the already-used workspace Vitest version.

Run: `pnpm --filter @doxahq/web test -- generation-model.test.ts`  
Expected: PASS.

Run: `pnpm --filter @doxahq/web typecheck`  
Expected: exit 0.

- [ ] **Step 7: Review checkpoint**

Confirm no `any`, no unsafe assertions, and no generic `/jobs` calls in the new query
path. Commit remains deferred.

---

### Task 4: Shared Project Workspace and Explicit Routes

**Files:**
- Create: `apps/web/src/components/dashboard/project-workspace-layout.tsx`
- Create: `apps/web/src/lib/dashboard/use-project-workspace.ts`
- Delete after replacement: `apps/web/src/routes/dashboard/projects/$projectId.tsx`
- Create: `apps/web/src/routes/dashboard/projects/$projectId/route.tsx`
- Create: `apps/web/src/routes/dashboard/projects/$projectId/index.tsx`
- Create: `apps/web/src/routes/dashboard/projects/$projectId/project.tsx`
- Create: `apps/web/src/routes/dashboard/projects/$projectId/generations/index.tsx`
- Create: `apps/web/src/routes/dashboard/projects/$projectId/generations/$generationId.tsx`
- Create: `apps/web/src/routes/dashboard/projects/$projectId/domains.tsx`

**Interfaces:**
- Consumes: `projectDetailQueryOptions(projectId)`
- Produces: `ProjectWorkspaceLayout` with `Outlet`
- Produces: explicit typed route links and base-route redirect

- [ ] **Step 1: Create thin route modules**

The base index throws a TanStack Router redirect to the explicit Project route with
the current `projectId`. Child routes only read params and render their page component.

- [ ] **Step 2: Implement the shared workspace hook**

Load project detail with active-job polling only while `latestJob` is non-terminal.
Return project, docs URL, loading, refreshing, and load error. Do not load domains or
events.

- [ ] **Step 3: Implement the shared layout and route-linked tabs**

Use `DashboardHeader.tabs`, `Link`, and `Outlet`. Tabs use stable URLs, Lucide icons,
visible `focus-visible` rings, horizontal overflow, and a blue bottom border when active.
Set Project and Domains links to exact matching; let Generations stay active for detail
children.

- [ ] **Step 4: Generate the route tree and verify compilation**

Run: `pnpm --filter @doxahq/web build`  
Expected: route tree regenerates and every explicit route prerenders without a render
crash.

- [ ] **Step 5: Review checkpoint**

Confirm route modules remain thin and shared header logic exists once. Commit remains
deferred.

---

### Task 5: Focused Project, Generations, Detail, and Domains Pages

**Files:**
- Create: `apps/web/src/components/dashboard/project-overview-page.tsx`
- Create: `apps/web/src/components/dashboard/project-generations-page.tsx`
- Create: `apps/web/src/components/dashboard/project-generation-page.tsx`
- Create: `apps/web/src/components/dashboard/project-domains-page.tsx`
- Create: `apps/web/src/components/dashboard/project-generation-list.tsx`
- Create: `apps/web/src/components/dashboard/project-generation-log.tsx`
- Create: `apps/web/src/lib/dashboard/use-project-generations.ts`
- Create: `apps/web/src/lib/dashboard/use-project-generation.ts`
- Create: `apps/web/src/lib/dashboard/use-project-domains.ts`
- Remove after replacement: `apps/web/src/components/dashboard/project-detail-page.tsx`
- Remove after replacement: `apps/web/src/lib/dashboard/use-project-detail.ts`

**Interfaces:**
- Consumes: Task 3 query options and model helpers
- Produces: focused route page components and data hooks

- [ ] **Step 1: Extract the Project page**

Render project status, slug, repository, docs target, and latest generation link with
existing `FieldRow`, `SectionLabel`, and badge patterns. Do not load domains or events.

- [ ] **Step 2: Extract the Domains page and hook**

Move existing domain form, mutation, cache update, verification, refresh, and disable
behavior without changing API calls or destructive-action semantics. Preserve loading,
validation, and provider-status states.

- [ ] **Step 3: Implement the generation list hook**

Use `useInfiniteQuery`, flatten and deduplicate pages, expose loaded count and next-page
state, and poll only while the first page contains queued or running jobs. The Generate
Docs mutation updates project and generation caches, invalidates summary data, then
navigates to the returned generation detail route.

- [ ] **Step 4: Implement the dense generations list**

Use one bordered list with row dividers. Each row is a semantic `Link` containing status,
short ID, created time, duration, published marker, and bounded failure summary. Use a
responsive stacked mobile layout, `min-w-0`, `break-words`, and tabular numerals. Preserve
rows while Load More is pending.

- [ ] **Step 5: Implement the generation detail hook**

Load project-scoped generation and events. Treat a project mismatch as not found even
though the server already scopes it. Poll both queries only while active. Update a local
clock once per second only for live elapsed time and clean up its interval.

- [ ] **Step 6: Implement generation metadata and event log**

Render a Back to Generations link, metadata field rows, progress, current event, failure
alert, and chronological event log. Render event values through text nodes and bounded
metadata helpers. Never use raw HTML or automatic links.

- [ ] **Step 7: Remove the monolithic page after route replacement**

Delete only the superseded `project-detail-page.tsx` and `use-project-detail.ts` once all
imports have moved. Preserve unrelated user edits in every other dashboard file.

- [ ] **Step 8: Run web tests, typecheck, and build**

Run: `pnpm --filter @doxahq/web test`  
Expected: PASS.

Run: `pnpm --filter @doxahq/web typecheck`  
Expected: exit 0.

Run: `pnpm --filter @doxahq/web build`  
Expected: exit 0 with the generated route tree containing all explicit routes.

- [ ] **Step 9: Review checkpoint**

Confirm page-specific hooks do not fetch unrelated data and component files contain no
query definitions. Commit remains deferred.

---

### Task 6: Security, Browser, and Interface-Guideline Verification

**Files:**
- Modify only if findings require it: files changed in Tasks 1 through 5
- Verify generated: `apps/web/src/routeTree.gen.ts`

**Interfaces:**
- Consumes: complete feature
- Produces: verified behavior and a concise findings report

- [ ] **Step 1: Run focused and package verification**

Run:

```bash
pnpm --filter @doxahq/api test
pnpm --filter @doxahq/api typecheck
pnpm --filter @doxahq/contracts typecheck
pnpm --filter @doxahq/web test
pnpm --filter @doxahq/web typecheck
pnpm --filter @doxahq/web build
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 2: Perform a targeted authorization review**

Trace each new endpoint from route through repository query. Confirm no code path can
read a list, generation, or event by client-supplied ID without authenticated project
ownership. Confirm cursors affect ordering only and page-size bounds are enforced.

- [ ] **Step 3: Start local services for visual QA**

Run the existing local API and web services with the explicit dev-user mode only for
local verification. Do not mutate remote resources or run real generation.

- [ ] **Step 4: Verify desktop and mobile flows in a real browser**

Check redirect, explicit URLs, active tabs, keyboard focus, Project page, empty and
populated generation list, Load More, generation detail, event overflow, Domains page,
long content, and mobile horizontal tabs. Capture screenshots at desktop and mobile
viewports and confirm no overlap, clipping, blank canvas, or unexpected horizontal page
scroll.

- [ ] **Step 5: Audit against the current Web Interface Guidelines**

Review changed UI files for semantic links/buttons, labels, `aria-current`, focus-visible
states, locale-safe dates, tabular numerals, reduced motion, loading ellipses, resilient
long text, and accessible async errors. Fix each concrete finding and rerun web checks.

- [ ] **Step 6: Final worktree review**

Run `git status --short` and inspect the complete targeted diff. Report unrelated
pre-existing changes separately. Do not commit without explicit approval.
