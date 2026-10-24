# User Generation Hard Cancel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a project owner confirm and hard-cancel a queued or running generation from its detail page.

**Architecture:** Add a shared API cancellation service that atomically marks an active job cancelled before requesting destruction of its per-job Cloudflare container. Expose that service through an ownership-scoped project route, then connect it to a controlled Radix confirmation dialog and a TanStack Query mutation that reconciles every affected dashboard cache.

**Tech Stack:** TypeScript 5.9, Hono 4.12, Cloudflare Workers and Containers, Drizzle ORM, React 19, TanStack Query 5, Radix Dialog, Tailwind CSS 4, Vitest 2.

## Global Constraints

- Only project owners may cancel their own generation.
- Only `queued` and `running` jobs may transition to `cancelled`.
- The database transition must precede container destruction so cancelled output cannot publish.
- Do not add a database migration, dependency, bulk action, retry flow, or delete flow.
- Use the project-scoped endpoint `POST /projects/:projectId/generations/:generationId/cancel`.
- Use the exact visible copy `Cancel generation`, `Keep running`, and `Cancelling…`.
- Keep Doxa's semantic color tokens, sharp corners, sentence-case buttons, visible focus states, and reduced-motion-safe animation.
- Use TDD for each behavior: write the test, observe the expected failure, add the minimum implementation, and rerun the focused test.
- Run Git from `/Users/islemmaboud/Source/Projects/CoderOne/doxa/doxa-platform` and preserve unrelated changes.

---

## File Map

- Create `apps/api/src/services/generation-cancellation.ts`: shared state transition and container-destroy orchestration.
- Create `apps/api/tests/services/generation-cancellation.test.ts`: deterministic cancellation-service coverage.
- Modify `apps/api/src/repositories/jobs.ts`: return whether `markCancelled` transitioned an active job.
- Modify `apps/api/src/routes/admin.ts`: reuse the shared cancellation service.
- Modify `apps/api/src/routes/projects.ts`: add the owner-scoped cancellation endpoint.
- Modify `apps/api/tests/http/projects.test.ts`: cover ownership, success, terminal races, and destroy dispatch.
- Modify `apps/web/src/lib/platform-api.ts`: add the project-scoped cancellation client.
- Create `apps/web/tests/platform-api.test.ts`: verify method, URL, credentials, and response parsing.
- Modify `apps/web/src/lib/dashboard/generation-model.ts`: expose the active-state predicate used by the UI.
- Modify `apps/web/tests/generation-model.test.ts`: cover cancellation visibility for every status.
- Modify `apps/web/src/lib/dashboard/use-project-generation.ts`: own the cancellation mutation and cache reconciliation.
- Create `apps/web/src/components/dashboard/generation-cancel-dialog.tsx`: controlled destructive confirmation UI.
- Create `apps/web/tests/generation-cancel-dialog.test.ts`: server-rendered active/terminal trigger coverage.
- Modify `apps/web/src/components/dashboard/project-generation-page.tsx`: place the active-only trigger beside the heading.
- Update `docs/superpowers/specs/2026-07-20-user-generation-hard-cancel-design.md`: mark the implemented design complete.

---

### Task 1: Shared API cancellation service

**Files:**
- Create: `apps/api/tests/services/generation-cancellation.test.ts`
- Create: `apps/api/src/services/generation-cancellation.ts`
- Modify: `apps/api/src/repositories/jobs.ts:340-355`
- Modify: `apps/api/src/routes/admin.ts:1-150`

**Interfaces:**
- Consumes: `Env.AGENT_CONTAINER`, `JobsRepository.markCancelled`, and `JobsRepository.addEvent`.
- Produces: `cancelGenerationJob(env, jobs, input): Promise<GenerationCancellationResult>` and `recordContainerDestroyAttempt(env, jobs, jobId): Promise<boolean>`.

- [ ] **Step 1: Write failing service tests**

Create tests that supply a small fake repository and binding:

```ts
import { describe, expect, test, vi } from "vitest"

import { cancelGenerationJob } from "../../src/services/generation-cancellation"

describe("generation cancellation", () => {
  test("marks an active job cancelled before destroying its container", async () => {
    const order: string[] = []
    const jobs = {
      markCancelled: vi.fn(async () => { order.push("cancelled"); return true }),
      addEvent: vi.fn(async () => undefined),
    }
    const fetch = vi.fn(async () => { order.push("destroyed"); return Response.json({ ok: true }) })

    const result = await cancelGenerationJob(
      { AGENT_CONTAINER: { fetch } } as never,
      jobs,
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        message: "Cancelled by user.",
        eventType: "user_cancel_requested",
        data: { requestedByUserId: "user-1" },
      },
    )

    expect(order).toEqual(["cancelled", "destroyed"])
    expect(result).toEqual({ transitioned: true, containerDestroyRequested: true })
    expect(jobs.addEvent).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "container_destroy_requested",
      "Agent container destroy requested.",
      { ok: true },
    )
  })

  test("does not destroy a container when the job is already terminal", async () => {
    const jobs = {
      markCancelled: vi.fn(async () => false),
      addEvent: vi.fn(async () => undefined),
    }
    const fetch = vi.fn()

    await expect(cancelGenerationJob(
      { AGENT_CONTAINER: { fetch } } as never,
      jobs,
      { jobId: "job-1", message: "Cancelled by user." },
    )).resolves.toEqual({ transitioned: false, containerDestroyRequested: false })

    expect(fetch).not.toHaveBeenCalled()
    expect(jobs.addEvent).not.toHaveBeenCalled()
  })

  test("keeps the transition successful when container destruction is unavailable", async () => {
    const jobs = {
      markCancelled: vi.fn(async () => true),
      addEvent: vi.fn(async () => undefined),
    }

    await expect(cancelGenerationJob(
      {} as never,
      jobs,
      { jobId: "job-1", message: "Cancelled by user." },
    )).resolves.toEqual({ transitioned: true, containerDestroyRequested: false })

    expect(jobs.addEvent).toHaveBeenCalledWith(
      "job-1",
      "container_destroy_unavailable",
      "Agent container destroy could not be requested from this runtime.",
      { ok: false },
    )
  })
})
```

- [ ] **Step 2: Run the service test and verify RED**

Run:

```bash
pnpm --filter @doxahq/api test -- tests/services/generation-cancellation.test.ts
```

Expected: FAIL because `generation-cancellation.ts` does not exist.

- [ ] **Step 3: Return the transition result from the repository**

Change `markCancelled` to return the existing transactional boolean:

```ts
async markCancelled(
  jobId: string,
  message: string,
  eventType = "admin_cancel_requested",
  data?: Record<string, unknown>,
): Promise<boolean> {
  return this.transitionActiveJob({
    jobId,
    status: "cancelled",
    errorMessage: message,
    event: {
      type: eventType,
      message,
      data: { ...data, outcome: "cancelled", terminal: true },
    },
  })
}
```

The existing `markJobCancelled` wrapper in `services/internal-api.ts` already awaits
the call without returning it, so its `Promise<void>` RPC contract stays unchanged.

- [ ] **Step 4: Implement the focused cancellation service**

Create `generation-cancellation.ts` with these public contracts:

```ts
import type { Env } from "../env"
import type { JobsRepository } from "../repositories/jobs"

type CancellationJobs = Pick<JobsRepository, "markCancelled" | "addEvent">

export interface GenerationCancellationInput {
  jobId: string
  message: string
  eventType?: string
  data?: Record<string, unknown>
}

export interface GenerationCancellationResult {
  transitioned: boolean
  containerDestroyRequested: boolean
}

export async function cancelGenerationJob(
  env: Env,
  jobs: CancellationJobs,
  input: GenerationCancellationInput,
): Promise<GenerationCancellationResult> {
  const transitioned = await jobs.markCancelled(
    input.jobId,
    input.message,
    input.eventType,
    input.data,
  )
  if (!transitioned) return { transitioned: false, containerDestroyRequested: false }

  const containerDestroyRequested = await recordContainerDestroyAttempt(env, jobs, input.jobId)
  return { transitioned: true, containerDestroyRequested }
}

export async function recordContainerDestroyAttempt(
  env: Env,
  jobs: Pick<JobsRepository, "addEvent">,
  jobId: string,
): Promise<boolean> {
  const destroyed = await requestContainerDestroy(env, jobId)
  await jobs.addEvent(
    jobId,
    destroyed ? "container_destroy_requested" : "container_destroy_unavailable",
    destroyed
      ? "Agent container destroy requested."
      : "Agent container destroy could not be requested from this runtime.",
    { ok: destroyed },
  )
  return destroyed
}

async function requestContainerDestroy(env: Env, jobId: string): Promise<boolean> {
  if (!env.AGENT_CONTAINER) return false

  try {
    const response = await env.AGENT_CONTAINER.fetch(
      new Request(`https://agent-container.internal/admin/containers/${jobId}/destroy`, {
        method: "POST",
      }),
    )
    return response.ok
  } catch (err) {
    console.error(JSON.stringify({
      service: "doxa-api",
      eventType: "container_destroy_failed",
      jobId,
      error: err instanceof Error ? err.message : "request failed",
    }))
    return false
  }
}
```

Delete the now-duplicated destroy-request and event-recording functions from
`routes/admin.ts`.

- [ ] **Step 5: Reuse the service from admin routes**

Replace the single-job admin route's direct transition and local destroy helper with:

```ts
const result = await cancelGenerationJob(context.env, jobs, {
  jobId,
  message,
  eventType: "admin_cancel_requested",
  data: { requestedByUserId: admin.id },
})
return json({ ok: true, containerDestroyed: result.containerDestroyRequested })
```

Keep bulk cancellation using exported `recordContainerDestroyAttempt`. Delete the
duplicated private helper functions from `routes/admin.ts`.

- [ ] **Step 6: Run focused API tests and verify GREEN**

Run:

```bash
pnpm --filter @doxahq/api test -- tests/services/generation-cancellation.test.ts tests/http/admin.test.ts
```

Expected: PASS with no unhandled errors or warnings.

- [ ] **Step 7: Commit the shared API boundary**

```bash
git add apps/api/src/repositories/jobs.ts apps/api/src/routes/admin.ts apps/api/src/services/generation-cancellation.ts apps/api/tests/services/generation-cancellation.test.ts
git commit -m "refactor: centralize generation cancellation"
```

---

### Task 2: Owner-scoped cancellation endpoint

**Files:**
- Modify: `apps/api/tests/http/projects.test.ts`
- Modify: `apps/api/src/routes/projects.ts`

**Interfaces:**
- Consumes: `cancelGenerationJob` from Task 1 and `JobsRepository.getForProject`.
- Produces: `POST /projects/:projectId/generations/:generationId/cancel`, returning `{ generation: GenerationJobDto }`.

- [ ] **Step 1: Extend the project-route repository mock**

Add `markCancelled` and `addEvent` spies to `mocks.jobsRepository`. Default
`markCancelled` to `true` in `beforeEach`.

- [ ] **Step 2: Write failing route tests**

Add these behaviors to `projects.test.ts`:

```ts
test.each(["queued", "running"] as const)(
  "lets the project owner cancel a %s generation",
  async (status) => {
  const active = createGeneration({ status })
  const cancelled = createGeneration({
    status: "cancelled",
    errorMessage: "Cancelled by user.",
  })
  mocks.jobsRepository.getForProject
    .mockResolvedValueOnce(active)
    .mockResolvedValueOnce(cancelled)
  const destroy = vi.fn(async () => Response.json({ ok: true }))

  const response = await worker.fetch(
    createMutationRequest("/projects/project-1/generations/job-1/cancel"),
    createEnv({ AGENT_CONTAINER: { fetch: destroy } }),
    createExecutionContext(),
  )

  expect(response.status).toBe(200)
  expect(mocks.jobsRepository.markCancelled).toHaveBeenCalledWith(
    "job-1",
    "Cancelled by user.",
    "user_cancel_requested",
    { requestedByUserId: "user-1" },
  )
  expect(destroy).toHaveBeenCalledOnce()
  await expect(response.json()).resolves.toEqual({ generation: cancelled })
  },
)

test("does not reveal or cancel an inaccessible generation", async () => {
  mocks.jobsRepository.getForProject.mockResolvedValueOnce(null)

  const response = await worker.fetch(
    createMutationRequest("/projects/other-project/generations/job-1/cancel"),
    createEnv(),
    createExecutionContext(),
  )

  expect(response.status).toBe(404)
  expect(mocks.jobsRepository.markCancelled).not.toHaveBeenCalled()
})

test("returns conflict when the generation is already terminal", async () => {
  mocks.jobsRepository.markCancelled.mockResolvedValueOnce(false)

  const response = await worker.fetch(
    createMutationRequest("/projects/project-1/generations/job-1/cancel"),
    createEnv(),
    createExecutionContext(),
  )

  expect(response.status).toBe(409)
  await expect(response.json()).resolves.toEqual({
    error: { message: "Generation has already finished." },
  })
})
```

- [ ] **Step 3: Run the route tests and verify RED**

Run:

```bash
pnpm --filter @doxahq/api test -- tests/http/projects.test.ts
```

Expected: FAIL with `404` for the missing POST route.

- [ ] **Step 4: Add the ownership-scoped route**

Insert the route beside the generation detail and event endpoints:

```ts
app.post("/:projectId/generations/:generationId/cancel", (context) =>
  withUser(context, async (userId) => {
    const projectId = context.req.param("projectId")
    const generationId = context.req.param("generationId")
    const jobs = new JobsRepository(context.env)
    const generation = await jobs.getForProject({
      userId,
      projectId,
      jobId: generationId,
    })
    if (!generation) return notFound()

    const result = await cancelGenerationJob(context.env, jobs, {
      jobId: generation.id,
      message: "Cancelled by user.",
      eventType: "user_cancel_requested",
      data: { requestedByUserId: userId },
    })
    if (!result.transitioned) {
      return error("Generation has already finished.", 409)
    }

    const cancelled = await jobs.getForProject({ userId, projectId, jobId: generation.id })
    if (!cancelled) return notFound()
    return json({ generation: cancelled })
  }),
)
```

Import `cancelGenerationJob` from the new service. Do not accept a request body.

- [ ] **Step 5: Run route and service tests and verify GREEN**

Run:

```bash
pnpm --filter @doxahq/api test -- tests/http/projects.test.ts tests/services/generation-cancellation.test.ts
pnpm --filter @doxahq/api typecheck
```

Expected: both test files PASS and TypeScript reports no errors.

- [ ] **Step 6: Commit the owner endpoint**

```bash
git add apps/api/src/routes/projects.ts apps/api/tests/http/projects.test.ts
git commit -m "feat: let project owners cancel generations"
```

---

### Task 3: Web cancellation client and state model

**Files:**
- Create: `apps/web/tests/platform-api.test.ts`
- Modify: `apps/web/tests/generation-model.test.ts`
- Modify: `apps/web/src/lib/platform-api.ts`
- Modify: `apps/web/src/lib/dashboard/generation-model.ts`
- Modify: `apps/web/src/lib/dashboard/use-project-generation.ts`

**Interfaces:**
- Consumes: the endpoint from Task 2 and existing dashboard query keys/cache helpers.
- Produces: `cancelProjectGeneration(projectId, generationId)`, `canCancelGeneration(job)`, and hook fields `cancel`, `resetCancel`, `isCancelling`, and `cancelError`.

- [ ] **Step 1: Write the failing API-client test**

Create `platform-api.test.ts`:

```ts
import { afterEach, describe, expect, test, vi } from "vitest"
import type { GenerationJobDto } from "@doxahq/contracts"

import { cancelProjectGeneration } from "~/lib/platform-api"

describe("platform API", () => {
  afterEach(() => vi.unstubAllGlobals())

  test("cancels a generation through its owned project route", async () => {
    const generation = createGeneration({ status: "cancelled" })
    const fetch = vi.fn(async () => Response.json({ generation }))
    vi.stubGlobal("fetch", fetch)

    await expect(cancelProjectGeneration("project 1", "job/1")).resolves.toEqual(generation)
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:8787/projects/project%201/generations/job%2F1/cancel",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    )
  })
})
```

Include a local `createGeneration` fixture matching `GenerationJobDto`.

```ts
function createGeneration(overrides: Partial<GenerationJobDto> = {}): GenerationJobDto {
  return {
    id: "job-1",
    projectId: "project-1",
    status: "running",
    docsVersionId: null,
    errorMessage: null,
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:01:00.000Z",
    ...overrides,
  }
}
```

- [ ] **Step 2: Write the failing active-state model test**

Add:

```ts
test("allows cancellation only while a generation is active", () => {
  expect(canCancelGeneration(createGeneration({ status: "queued" }))).toBe(true)
  expect(canCancelGeneration(createGeneration({ status: "running" }))).toBe(true)
  expect(canCancelGeneration(createGeneration({ status: "succeeded" }))).toBe(false)
  expect(canCancelGeneration(createGeneration({ status: "failed" }))).toBe(false)
  expect(canCancelGeneration(createGeneration({ status: "cancelled" }))).toBe(false)
})
```

- [ ] **Step 3: Run both web tests and verify RED**

Run:

```bash
pnpm --filter @doxahq/web test -- tests/platform-api.test.ts tests/generation-model.test.ts
```

Expected: FAIL because both exports are missing.

- [ ] **Step 4: Add the API client and active-state predicate**

Add:

```ts
export async function cancelProjectGeneration(
  projectId: string,
  generationId: string,
): Promise<GenerationJobDto> {
  const result = await apiFetch<{ generation: GenerationJobDto }>(
    `/projects/${encodeURIComponent(projectId)}/generations/${encodeURIComponent(generationId)}/cancel`,
    { method: "POST" },
  )
  return result.generation
}
```

Add to `generation-model.ts`:

```ts
export function canCancelGeneration(job: GenerationJobDto): boolean {
  return job.status === "queued" || job.status === "running"
}
```

- [ ] **Step 5: Add the TanStack Query mutation**

Update `useProjectGeneration` to import `useMutation`, `useQueryClient`,
`cancelProjectGeneration`, `dashboardQueryKeys`, `mergeGenerationIntoPages`,
`mergeLatestJob`, `getErrorMessage`, `InfiniteData`, `GenerationsPageDto`, and
`ProjectDetail`. Configure:

```ts
const cancelMutation = useMutation({
  mutationFn: () => cancelProjectGeneration(projectId, generationId),
  onSuccess: (cancelled) => {
    queryClient.setQueryData(
      dashboardQueryKeys.generation(projectId, generationId),
      cancelled,
    )
    queryClient.setQueryData<InfiniteData<GenerationsPageDto> | undefined>(
      dashboardQueryKeys.generations(projectId),
      (data) => mergeGenerationIntoPages(data, cancelled),
    )
    queryClient.setQueryData<ProjectDetail | undefined>(
      dashboardQueryKeys.project(projectId),
      (project) => mergeLatestJob(project, cancelled),
    )
  },
  onSettled: async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.generationEvents(projectId, generationId) }),
      queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.generations(projectId) }),
      queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.project(projectId) }),
      queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.summary() }),
    ])
  },
})
```

Expose this guarded action and state:

```ts
async function cancel(): Promise<boolean> {
  if (cancelMutation.isPending) return false
  return cancelMutation.mutateAsync().then(() => true).catch(() => false)
}

cancel,
resetCancel: cancelMutation.reset,
isCancelling: cancelMutation.isPending,
cancelError: cancelMutation.error
  ? getErrorMessage(cancelMutation.error, "Failed to cancel generation. Try again.")
  : null,
```

- [ ] **Step 6: Run focused web tests and typecheck**

Run:

```bash
pnpm --filter @doxahq/web test -- tests/platform-api.test.ts tests/generation-model.test.ts tests/generation-stream.test.ts
pnpm --filter @doxahq/web typecheck
```

Expected: all tests PASS and TypeScript reports no errors.

- [ ] **Step 7: Commit the web data flow**

```bash
git add apps/web/src/lib/platform-api.ts apps/web/src/lib/dashboard/generation-model.ts apps/web/src/lib/dashboard/use-project-generation.ts apps/web/tests/platform-api.test.ts apps/web/tests/generation-model.test.ts
git commit -m "feat: add generation cancellation mutation"
```

---

### Task 4: Accessible confirmation UI

**Files:**
- Create: `apps/web/src/components/dashboard/generation-cancel-dialog.tsx`
- Create: `apps/web/tests/generation-cancel-dialog.test.ts`
- Modify: `apps/web/src/components/dashboard/project-generation-page.tsx:1-140`

**Interfaces:**
- Consumes: `canCancelGeneration` and the cancellation fields from Task 3.
- Produces: an active-only trigger and controlled confirmation dialog on the generation detail page.

- [ ] **Step 1: Write the failing component visibility test**

Create `generation-cancel-dialog.test.ts` without adding a DOM dependency:

```ts
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"

import { GenerationCancelDialog } from "~/components/dashboard/generation-cancel-dialog"

const baseProps = {
  isCancelling: false,
  error: null,
  onCancel: async () => true,
  onReset: vi.fn(),
}

describe("generation cancel dialog", () => {
  test("renders a dialog trigger only for active generations", () => {
    const active = renderToStaticMarkup(createElement(GenerationCancelDialog, {
      ...baseProps,
      canCancel: true,
    }))
    const terminal = renderToStaticMarkup(createElement(GenerationCancelDialog, {
      ...baseProps,
      canCancel: false,
    }))

    expect(active).toContain("Cancel generation")
    expect(active).toContain('aria-haspopup="dialog"')
    expect(terminal).toBe("")
  })
})
```

- [ ] **Step 2: Run the component test and verify RED**

Run:

```bash
pnpm --filter @doxahq/web test -- tests/generation-cancel-dialog.test.ts
```

Expected: FAIL because `generation-cancel-dialog.tsx` does not exist.

- [ ] **Step 3: Create the focused dialog component**

Implement `GenerationCancelDialog` with props:

```ts
interface GenerationCancelDialogProps {
  canCancel: boolean
  isCancelling: boolean
  error: string | null
  onCancel: () => Promise<boolean>
  onReset: () => void
}
```

Implement the component with this control flow and structure:

```tsx
import { useEffect, useState } from "react"
import { AlertCircle, CircleStop, Loader2 } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog"

interface GenerationCancelDialogProps {
  canCancel: boolean
  isCancelling: boolean
  error: string | null
  onCancel: () => Promise<boolean>
  onReset: () => void
}

export function GenerationCancelDialog({
  canCancel,
  isCancelling,
  error,
  onCancel,
  onReset,
}: GenerationCancelDialogProps) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!canCancel) setOpen(false)
  }, [canCancel])

  if (!canCancel) return null

  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen && isCancelling) return
    if (nextOpen) onReset()
    setOpen(nextOpen)
  }

  async function confirmCancellation(): Promise<void> {
    if (isCancelling) return
    if (await onCancel()) setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="destructive" size="sm">
          <CircleStop aria-hidden="true" />
          Cancel generation
        </Button>
      </DialogTrigger>
      <DialogContent
        className="overscroll-contain rounded-none motion-reduce:animate-none motion-reduce:transition-none sm:rounded-none"
        onEscapeKeyDown={(event) => {
          if (isCancelling) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (isCancelling) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-balance font-mono text-sm tracking-[0.12em] uppercase">
            Cancel generation?
          </DialogTitle>
          <DialogDescription className="text-pretty">
            This stops the active generation. No generated documentation from this run will be published.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <Alert variant="destructive" aria-live="polite">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>Could not cancel generation</AlertTitle>
            <AlertDescription className="break-words">{error}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={isCancelling}>
              Keep running
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={isCancelling}
            onClick={() => void confirmCancellation()}
          >
            {isCancelling ? (
              <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />
            ) : (
              <CircleStop aria-hidden="true" />
            )}
            {isCancelling ? "Cancelling…" : "Cancel generation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

Verify these behaviors in the implementation:

- Keep `open` in local state.
- Call `onReset` whenever a new dialog session opens.
- Ignore `onOpenChange(false)` while `isCancelling` is true.
- Close only when `await onCancel()` returns `true`.
- Close automatically if `canCancel` becomes `false` because SSE or polling won the race.
- Use `DialogTrigger asChild`, `DialogTitle`, `DialogDescription`, and `DialogFooter`.
- Render `CircleStop` and `Loader2` with `aria-hidden="true"`.
- Render the error inside an `Alert` with `aria-live="polite"`.
- Disable **Keep running** and **Cancel generation** while pending.
- Render **Cancelling…** with `motion-safe:animate-spin` while pending.
- Add `motion-reduce:animate-none` and `overscroll-contain` to dialog content.

- [ ] **Step 4: Place the trigger beside the generation heading**

Change the title block into a responsive row with `min-w-0`, keep the existing title
and description unchanged, and render:

```tsx
<GenerationCancelDialog
  canCancel={canCancelGeneration(state.generation)}
  isCancelling={state.isCancelling}
  error={state.cancelError}
  onCancel={state.cancel}
  onReset={state.resetCancel}
/>
```

Do not render cancellation UI for terminal jobs. Preserve the status card, failure
alert, event log, back link, and stream behavior.

- [ ] **Step 5: Run the component test, web typecheck, and build**

Run:

```bash
pnpm --filter @doxahq/web test -- tests/generation-cancel-dialog.test.ts
pnpm --filter @doxahq/web typecheck
pnpm --filter @doxahq/web build
```

Expected: both commands exit `0`; the build prerenders all routes without a dialog
portal or hydration failure.

- [ ] **Step 6: Browser-check the interaction**

Start the existing local stack with its documented dev-user configuration. Verify
at desktop and narrow mobile widths:

- Active generation shows **Cancel generation**; terminal generation does not.
- Trigger, secondary action, destructive action, Escape, and close button are usable
  with the keyboard.
- Focus enters the dialog and returns to the trigger after dismissal.
- The confirmation copy wraps without horizontal overflow.
- Pending state shows **Cancelling…**, blocks duplicates, and honors reduced motion.
- An injected failed response remains in the dialog as an announced inline error.
- A successful response closes the dialog and updates status and log without reload.

- [ ] **Step 7: Run the fresh Web Interface Guidelines review**

Fetch the latest rules from:

```text
https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md
```

Review `generation-cancel-dialog.tsx` and the changed portion of
`project-generation-page.tsx`. Fix every finding introduced by this feature, then
rerun typecheck and build.

- [ ] **Step 8: Commit the cancellation UI**

```bash
git add apps/web/src/components/dashboard/generation-cancel-dialog.tsx apps/web/src/components/dashboard/project-generation-page.tsx apps/web/tests/generation-cancel-dialog.test.ts
git commit -m "feat: add generation cancel confirmation"
```

---

### Task 5: Full verification and documentation closeout

**Files:**
- Modify: `docs/superpowers/specs/2026-07-20-user-generation-hard-cancel-design.md`

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: a verified feature and an implementation-complete design record.

- [ ] **Step 1: Run focused and full verification**

Run:

```bash
pnpm --filter @doxahq/api test
pnpm --filter @doxahq/web test
pnpm --filter @doxahq/api typecheck
pnpm --filter @doxahq/web typecheck
pnpm --filter @doxahq/web build
pnpm test
pnpm typecheck
```

Expected: every command exits `0` with no new warnings. If a repository-wide command
fails for an unrelated pre-existing reason, record the exact command and failure,
while keeping all feature-focused checks green.

- [ ] **Step 2: Review the final diff**

Run:

```bash
git diff --check
git status --short
git diff 176a6fa..HEAD -- apps/api apps/web docs/superpowers
```

Confirm no secrets, generated route noise, raw colors, unrelated refactors,
authorization regressions, or accidental dependency changes entered the diff.

- [ ] **Step 3: Mark the design implemented**

Change the design header to:

```markdown
**Status:** Implemented and verified
```

Append a short verification section listing the exact passing commands and browser
checks. Do not claim any check that did not run.

- [ ] **Step 4: Commit the verified closeout**

```bash
git add docs/superpowers/specs/2026-07-20-user-generation-hard-cancel-design.md docs/superpowers/plans/2026-07-20-user-generation-hard-cancel.md
git commit -m "docs: record generation cancellation verification"
```

- [ ] **Step 5: Report the outcome**

Summarize the owner authorization boundary, hard-cancel semantics, UI behavior,
tests, browser verification, commits, and any skipped checks. Link the main API
route, cancellation service, dialog component, spec, and plan with absolute paths.
