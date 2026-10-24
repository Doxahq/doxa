// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

import { DeleteTeamCard } from "~/components/dashboard/teams/delete-team-card"

afterEach(cleanup)

function renderCard(overrides: Partial<Parameters<typeof DeleteTeamCard>[0]> = {}) {
  const props = {
    teamName: "CoderOne",
    hasProjects: false,
    isDeleting: false,
    error: null,
    deleteTeam: vi.fn(async () => undefined),
    onDeleted: vi.fn(),
    resetError: vi.fn(),
    ...overrides,
  }
  render(<DeleteTeamCard {...props} />)
  return props
}

function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Delete team" }))
  return screen.getByRole("dialog")
}

describe("delete team card", () => {
  test("deletes only after the user types the team name", async () => {
    const props = renderCard()
    const dialog = openDialog()
    const confirm = () => screen.getAllByRole("button", { name: "Delete team" }).at(-1)
    expect(dialog.textContent).toContain("Type CoderOne to confirm")
    expect(confirm()?.hasAttribute("disabled")).toBe(true)

    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "Coder" } })
    expect(confirm()?.hasAttribute("disabled")).toBe(true)

    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "CoderOne" } })
    fireEvent.click(confirm()!)

    await waitFor(() => expect(props.onDeleted).toHaveBeenCalledTimes(1))
    expect(props.deleteTeam).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  test("keeps the dialog open when the delete fails", async () => {
    const props = renderCard({ deleteTeam: vi.fn(async () => Promise.reject(new Error("409"))) })
    openDialog()
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "CoderOne" } })
    fireEvent.click(screen.getAllByRole("button", { name: "Delete team" }).at(-1)!)

    await waitFor(() => expect(props.deleteTeam).toHaveBeenCalledTimes(1))
    expect(props.onDeleted).not.toHaveBeenCalled()
    expect(screen.getByRole("dialog")).toBeTruthy()
  })

  test("shows the error and clears an old one when the dialog opens", () => {
    const props = renderCard({ error: "The team could not be deleted." })
    openDialog()
    expect(props.resetError).toHaveBeenCalledTimes(1)
    expect(screen.getByText("Could not delete team")).toBeTruthy()
  })

  test("cannot open while the team has projects", () => {
    renderCard({ hasProjects: true })
    expect(screen.getByRole("button", { name: "Delete team" }).hasAttribute("disabled")).toBe(true)
    expect(screen.getByText(/Delete its projects first/)).toBeTruthy()
  })
})
