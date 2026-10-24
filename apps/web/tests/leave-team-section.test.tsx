// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, test, vi } from "vitest"

import { LeaveTeamSection } from "~/components/dashboard/teams/leave-team-section"
import { LEAVE_BLOCK_NOTES, type LeaveBlockReason } from "~/lib/dashboard/teams-model"

afterEach(cleanup)

describe("leave team section", () => {
  test("disables leaving for the only owner and says why", () => {
    renderSection("only_owner")
    const button = leaveButton()
    expect(button.disabled).toBe(true)
    expect(screen.getByText(LEAVE_BLOCK_NOTES.only_owner)).toBeTruthy()
    expect(button.getAttribute("aria-describedby")).toBeTruthy()
  })

  test("tells the only member to delete the team instead", () => {
    renderSection("only_member")
    expect(leaveButton().disabled).toBe(true)
    expect(screen.getByText(LEAVE_BLOCK_NOTES.only_member)).toBeTruthy()
  })

  test("lets any other member confirm and leave", async () => {
    const onLeave = renderSection(null)
    expect(leaveButton().disabled).toBe(false)
    expect(screen.queryByText(LEAVE_BLOCK_NOTES.only_owner)).toBeNull()

    await userEvent.click(leaveButton())
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy()
    await userEvent.click(leaveButton())
    expect(onLeave).toHaveBeenCalledOnce()
  })
})

function renderSection(blockReason: LeaveBlockReason | null) {
  const onLeave = vi.fn()
  render(<LeaveTeamSection blockReason={blockReason} isLeaving={false} onLeave={onLeave} />)
  return onLeave
}

function leaveButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", { name: "Leave team" })
}
