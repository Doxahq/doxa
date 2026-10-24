import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { TeamRole } from "@doxahq/contracts/teams"
import { afterEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  useProjectDomains: vi.fn(),
  role: "owner" as TeamRole,
}))

// The page reads the role from the project query; these tests have no query client.
vi.mock("~/lib/dashboard/use-project-capabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/dashboard/use-project-capabilities")>()
  return { ...actual, useProjectCapabilities: () => actual.projectCapabilities(mocks.role) }
})

vi.mock("~/lib/dashboard/use-project-domains", () => ({
  useProjectDomains: mocks.useProjectDomains,
}))

vi.mock("~/components/dashboard/page-back-navigation", () => ({
  ProjectsBackNavigation: () => null,
}))

vi.mock("~/components/dashboard/docs-domain-card", () => ({
  DocsDomainCard: () => null,
}))

const { ProjectDomainsPage } =
  await import("~/components/dashboard/project-domains-page")

afterEach(() => {
  mocks.role = "owner"
})

describe("ProjectDomainsPage", () => {
  test("disables domain creation when the project reaches its limit", () => {
    mocks.useProjectDomains.mockReturnValue(
      createState({
        domains: [{ id: "domain-1" }],
        customDomainLimit: 1,
        canAddDomain: false,
        isDomainLimitReached: true,
      }),
    )

    const markup = renderToStaticMarkup(
      createElement(ProjectDomainsPage, { projectId: "project-1" }),
    )

    expect(markup).toContain('aria-label="Custom domain hostname"')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain("Custom domain limit reached")
  })

  test("keeps domain creation available below the returned limit", () => {
    mocks.useProjectDomains.mockReturnValue(
      createState({
        domains: [],
        customDomainLimit: 2,
        canAddDomain: true,
        isDomainLimitReached: false,
      }),
    )

    const markup = renderToStaticMarkup(
      createElement(ProjectDomainsPage, { projectId: "project-1" }),
    )
    const input = markup.match(
      /<input[^>]+aria-label="Custom domain hostname"[^>]*>/,
    )?.[0]

    expect(input).toBeDefined()
    expect(input).not.toContain('disabled=""')
    expect(markup).not.toContain("Custom domain limit reached")
  })

  test("does not report a reached limit when the domain request fails", () => {
    mocks.useProjectDomains.mockReturnValue(
      createState({
        canAddDomain: false,
        isDomainLimitReached: false,
        error: "Failed to load docs domains.",
      }),
    )

    const markup = renderToStaticMarkup(
      createElement(ProjectDomainsPage, { projectId: "project-1" }),
    )

    expect(markup).not.toContain("Custom domain limit reached")
    expect(markup).toContain("Failed to load docs domains.")
  })
})

describe("ProjectDomainsPage roles", () => {
  test("an editor sees the domains but no add form", () => {
    mocks.role = "editor"
    mocks.useProjectDomains.mockReturnValue(createState({}))

    const markup = renderToStaticMarkup(
      createElement(ProjectDomainsPage, { projectId: "project-1" }),
    )

    expect(markup).not.toContain('aria-label="Custom domain hostname"')
    expect(markup).not.toContain("Add domain")
    expect(markup).toContain("Only a project owner or admin can add, check or remove custom domains.")
  })

  test("an admin keeps the add form", () => {
    mocks.role = "admin"
    mocks.useProjectDomains.mockReturnValue(createState({}))

    const markup = renderToStaticMarkup(
      createElement(ProjectDomainsPage, { projectId: "project-1" }),
    )

    expect(markup).toContain('aria-label="Custom domain hostname"')
    expect(markup).toContain("Add domain")
  })
})

function createState(overrides: Record<string, unknown>) {
  return {
    domains: [],
    customDomainLimit: 1,
    canAddDomain: true,
    isDomainLimitReached: false,
    hostname: "",
    setHostname: vi.fn(),
    addDomain: vi.fn(),
    refreshDomain: vi.fn(),
    deleteDomain: vi.fn(),
    isLoading: false,
    isCreating: false,
    refreshingDomainId: null,
    deletingDomainId: null,
    error: null,
    ...overrides,
  }
}
