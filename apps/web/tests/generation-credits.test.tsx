// @vitest-environment jsdom
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { GenerationJobDto, JobEventDto } from "@doxahq/contracts"

import { JobStatusBadge } from "~/components/dashboard/dashboard-status"
import { CAP_TOOLTIP, GenerationCreditsField, GenerationCreditsStopped } from "~/components/dashboard/generation-credits"
import { buildAttentionItems } from "~/components/dashboard/overview/attention-queue"
import {
  creditsStopAction,
  generationLogEvents,
  readCreditMeter,
  readCreditsStop,
} from "~/lib/dashboard/generation-credits"
import { getDeploymentLabel } from "~/lib/dashboard/generation-model"
import { getJobProgress, isTerminalJob } from "~/lib/dashboard/model"

afterEach(cleanup)

let sequence = 0
function event(type: string, data: Record<string, unknown> | null = null): JobEventDto {
  sequence += 1
  return {
    id: `event-${sequence}`,
    jobId: "job-1",
    sequence,
    source: "api",
    type,
    message: type,
    data,
    createdAt: "2026-11-14T10:00:00.000Z",
  }
}

function credits(data: Partial<{ usedCredits: number; jobUsedCredits: number; holdCredits: number; capCredits: number; fromPaygCredits: number; shadow: boolean }>) {
  return event("credits", { usedCredits: 0, holdCredits: 0, capCredits: 3_000, fromPaygCredits: 0, shadow: false, ...data })
}

const STOPPED_JOB: GenerationJobDto = {
  id: "job-1",
  projectId: "project-1",
  status: "stopped_credits",
  docsVersionId: null,
  errorMessage: "AI credits ran out.",
  createdAt: "2026-11-14T10:00:00.000Z",
  updatedAt: "2026-11-14T10:05:00.000Z",
}

/** Renders router `Link`s outside the app's route tree. */
function withRouter(children: ReactNode) {
  const rootRoute = createRootRoute({ component: () => <>{children}</> })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ["/"] }) })
  return <RouterProvider router={router} />
}

describe("live credit meter", () => {
  test("reads the newest credits event: used of cap, and the pay-as-you-go part", () => {
    const meter = readCreditMeter([
      credits({ usedCredits: 200 }),
      event("page_written"),
      credits({ usedCredits: 1_240, fromPaygCredits: 240 }),
    ])
    expect(meter).toMatchObject({ usedCredits: 1_240, capCredits: 3_000, capLine: "This run's cap: 3,000 credits" })
    expect(meter?.paygLine).toBe("$2.40 from pay-as-you-go")
    expect(readCreditMeter([credits({ usedCredits: 50 })])?.paygLine).toBeNull()
  })

  test("a continued run shows the job total, so the number never goes down", () => {
    const meter = readCreditMeter([
      credits({ usedCredits: 2_700, jobUsedCredits: 2_700 }),
      // The continue: a new try with no base fee, on top of the first one.
      credits({ usedCredits: 40, jobUsedCredits: 2_740 }),
    ])
    expect(meter).toMatchObject({ usedCredits: 2_740, capLine: "This run's cap: 3,000 credits" })
  })

  test("shadow mode is invisible: no meter, and no log line", () => {
    const events = [credits({ usedCredits: 900, shadow: true }), event("running")]
    expect(readCreditMeter(events)).toBeNull()
    expect(generationLogEvents(events).map((item) => item.type)).toEqual(["running"])
  })

  test("no meter without a credits event, or with a malformed one", () => {
    expect(readCreditMeter([event("running")])).toBeNull()
    expect(readCreditMeter([event("credits", { usedCredits: "a lot" })])).toBeNull()
  })

  test("the summary field shows the credits so far, the pay-as-you-go amount, and the cap as a link to the caps", async () => {
    const meter = readCreditMeter([credits({ usedCredits: 2_700, fromPaygCredits: 150 })])!
    render(withRouter(<GenerationCreditsField meter={meter} billingAccountId="acct-1" />))
    // Screen readers read the plain number; the rolling digits are hidden from them.
    expect(await screen.findByText("2,700")).toBeTruthy()
    expect(screen.getByText("$1.50 from pay-as-you-go")).toBeTruthy()
    const cap = screen.getByRole("link", { name: "This run's cap: 3,000 credits" })
    expect(cap.getAttribute("href")).toBe("/dashboard/billing/acct-1/credits#caps")
    // No progress bar: the credits are spent, not a task to finish.
    expect(screen.queryByRole("meter")).toBeNull()
  })

  test("the cap's tooltip says that it is the cap this run started with", async () => {
    const meter = readCreditMeter([credits({ usedCredits: 54, capCredits: 280 })])!
    render(withRouter(<GenerationCreditsField meter={meter} billingAccountId="acct-1" />))
    const cap = await screen.findByRole("link", { name: "This run's cap: 280 credits" })
    await userEvent.tab()
    expect(document.activeElement).toBe(cap)
    expect((await screen.findByRole("tooltip")).textContent).toBe(CAP_TOOLTIP)
  })

  test("without a billing account, the cap links to the billing page", async () => {
    const meter = readCreditMeter([credits({ usedCredits: 10 })])!
    render(withRouter(<GenerationCreditsField meter={meter} billingAccountId={null} />))
    expect((await screen.findByRole("link", { name: "This run's cap: 3,000 credits" })).getAttribute("href")).toBe("/dashboard/billing")
  })
})

describe("a run stopped for credits", () => {
  test("reads the reason and the finished pages from the stop event", () => {
    expect(readCreditsStop([event("credits_stopped", { reason: "credit_cap", finishedPageCount: 7 })])).toEqual({
      reason: "credit_cap",
      finishedPageCount: 7,
    })
    expect(readCreditsStop([])).toEqual({ reason: null, finishedPageCount: null })
    expect(creditsStopAction("credit_cap")).toEqual({ label: "Raise the cap", hash: "caps" })
    expect(creditsStopAction("credits_exhausted")).toEqual({ label: "Raise the monthly limit", hash: "payg" })
  })

  test("the notice shows the credits used, the finished pages, the billing link and Continue run", async () => {
    const onResume = vi.fn()
    render(
      withRouter(
        <GenerationCreditsStopped
          stop={{ reason: "credits_exhausted", finishedPageCount: 12 }}
          usedCredits={1_850}
          message="AI credits ran out."
          billingAccountId="account-1"
          canResume
          isResuming={false}
          onResume={onResume}
        />,
      ),
    )
    expect(await screen.findByText("The run ran out of AI credits")).toBeTruthy()
    expect(screen.getByText(/1,850 credits used\. 12 pages finished\./)).toBeTruthy()
    expect(screen.getByRole("link", { name: "Raise the monthly limit" }).getAttribute("href")).toBe(
      "/dashboard/billing/account-1/credits#payg",
    )
    await userEvent.click(screen.getByRole("button", { name: "Continue run" }))
    expect(onResume).toHaveBeenCalledOnce()
  })

  test("at the cap without a resume, it links to the caps and offers no Continue run", async () => {
    render(
      withRouter(
        <GenerationCreditsStopped
          stop={{ reason: "credit_cap", finishedPageCount: null }}
          usedCredits={null}
          message={null}
          billingAccountId="account-1"
          canResume={false}
          isResuming={false}
          onResume={() => undefined}
        />,
      ),
    )
    expect(await screen.findByText("The run reached its credit cap")).toBeTruthy()
    expect(screen.getByRole("link", { name: "Raise the cap" }).getAttribute("href")).toBe("/dashboard/billing/account-1/credits#caps")
    expect(screen.queryByRole("button", { name: "Continue run" })).toBeNull()
  })

  test("is terminal everywhere: progress, badge, deployment label, overview attention", () => {
    expect(isTerminalJob(STOPPED_JOB)).toBe(true)
    expect(getJobProgress(STOPPED_JOB, [])).toBe(100)
    expect(getDeploymentLabel("stopped_credits")).toBe("Stopped")
    render(<JobStatusBadge status="stopped_credits" />)
    expect(screen.getByText("out of credits")).toBeTruthy()

    const items = buildAttentionItems({
      projectId: "project-1",
      review: null,
      merges: [],
      doxabot: null,
      approvals: [],
      mdxPageCount: 0,
      latestJob: STOPPED_JOB,
      domains: [],
      onGenerate: null,
      isGenerating: false,
    })
    expect(items.map((item) => item.id)).toContain("stopped-generation")
  })
})
