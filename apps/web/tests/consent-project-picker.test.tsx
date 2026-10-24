// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AgentConsentProject } from "@doxahq/contracts/agent-access"
import { afterEach, describe, expect, test, vi } from "vitest"

import { ConsentProjectPicker } from "~/components/oauth/consent-project-picker"

afterEach(cleanup)

const ACME = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Acme" }

function project(id: string, name: string, team: AgentConsentProject["team"]): AgentConsentProject {
  return { id, name, slug: name.toLowerCase(), team }
}

const PERSONAL = project("11111111-1111-4111-8111-111111111111", "Mine", null)
const SHARED = project("22222222-2222-4222-8222-222222222222", "Shared", ACME)

describe("consent project picker", () => {
  test("groups the projects by team, personal first", () => {
    render(
      <ConsentProjectPicker
        projects={[SHARED, PERSONAL]}
        choice={{ kind: "selected", projectIds: new Set() }}
        issue={null}
        disabled={false}
        onChange={() => undefined}
      />,
    )
    const groups = screen.getAllByRole("group").filter((group) => group.tagName === "DIV")
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(["Personal", "Acme"])
    expect(within(groups[1]).getByText("Shared")).toBeTruthy()
  })

  test("keeps the flat list when every project is personal", () => {
    render(
      <ConsentProjectPicker
        projects={[PERSONAL]}
        choice={{ kind: "selected", projectIds: new Set() }}
        issue={null}
        disabled={false}
        onChange={() => undefined}
      />,
    )
    expect(screen.queryByText("Personal")).toBeNull()
    expect(screen.getByText("Mine")).toBeTruthy()
  })

  test("selects a team project", async () => {
    const onChange = vi.fn()
    render(
      <ConsentProjectPicker
        projects={[PERSONAL, SHARED]}
        choice={{ kind: "selected", projectIds: new Set() }}
        issue={null}
        disabled={false}
        onChange={onChange}
      />,
    )
    await userEvent.click(within(screen.getByRole("group", { name: "Acme" })).getByRole("checkbox"))
    expect(onChange).toHaveBeenCalledWith({ kind: "selected", projectIds: new Set([SHARED.id]) })
  })
})
