// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/dashboard/projects/p1/site/navigation" } }),
}))

import { SidebarProvider } from "~/components/ui/sidebar"
import {
  ProjectGenerationSkeleton,
  ProjectGenerationsSkeleton,
  ProjectOverviewSkeleton,
} from "~/components/dashboard/skeletons/project-skeletons"
import { ApprovalRequestSkeleton, ProjectRequestsSkeleton } from "~/components/dashboard/skeletons/request-skeletons"
import { ProjectApprovalsSkeleton, ProjectSettingsSkeleton } from "~/components/dashboard/skeletons/settings-skeletons"
import { SiteSettingsPending } from "~/components/dashboard/skeletons/site-settings-skeletons"
import { AccountSettingsSkeleton, TeamSkeleton, TeamsSkeleton } from "~/components/dashboard/skeletons/account-skeletons"

// The sidebar provider asks whether the window is narrow. jsdom has no media queries.
beforeEach(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
})

afterEach(cleanup)

const SKELETONS = {
  ProjectOverviewSkeleton,
  ProjectGenerationsSkeleton,
  ProjectGenerationSkeleton,
  ProjectRequestsSkeleton,
  ApprovalRequestSkeleton,
  ProjectSettingsSkeleton,
  ProjectApprovalsSkeleton,
  SiteSettingsPending,
  AccountSettingsSkeleton,
  TeamsSkeleton,
  TeamSkeleton,
}

describe("page skeletons", () => {
  test.each(Object.entries(SKELETONS))("%s announces one loading state, with sized bars", (_name, Skeleton) => {
    // The account pages draw their own top bar, which reads the sidebar state.
    const { container } = render(
      <SidebarProvider>
        <Skeleton />
      </SidebarProvider>,
    )
    expect(screen.getAllByRole("status")).toHaveLength(1)
    const bars = [...container.querySelectorAll("span.bg-muted")] as HTMLElement[]
    expect(bars.length).toBeGreaterThan(0)
    // Inline sizes: a dev server that missed a new class cannot hide a bar.
    expect(bars.every((bar) => bar.style.width && bar.style.height)).toBe(true)
  })

  test("the site settings skeleton shows the section that is loading, with its real heading", () => {
    render(<SiteSettingsPending />)
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Navigation")
    expect(screen.getByText("Default page")).toBeTruthy()
  })
})

describe("dashboard routes", () => {
  // A route that shows the router's spinner and then its page's skeleton
  // shows two loading states in a row. Each project route names its skeleton.
  test("every dashboard route with a pending view draws its own skeleton, not the spinner", () => {
    const root = join(__dirname, "../src/routes/dashboard")
    const files = walk(root).filter((file) => readFileSync(file, "utf8").includes("projectPagePending"))
    expect(files.length).toBeGreaterThan(15)
    const missing = files.filter((file) => !readFileSync(file, "utf8").includes("pendingComponent:"))
    expect(missing).toEqual([])
  })
})

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}
