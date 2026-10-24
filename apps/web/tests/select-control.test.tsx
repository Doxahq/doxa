// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

import { Select } from "~/components/dashboard/content/site-settings/fields/controls"
import {
  installRadixSelectPolyfills,
  pickSelectOption,
  readSelectOptions,
  selectedLabel,
} from "./support/radix-select"

installRadixSelectPolyfills()
afterEach(cleanup)

const OPTIONS = [
  { value: "", label: "None" },
  { value: "viewer", label: "Viewer" },
  { value: "editor", label: "Editor" },
] as const

type Role = (typeof OPTIONS)[number]["value"]

describe("Select control", () => {
  test("shows the label of the value and lists every option", async () => {
    render(<Select aria-label="Role" value={"viewer" as Role} options={OPTIONS} onValueChange={vi.fn()} />)

    expect(selectedLabel("Role")).toBe("Viewer")
    expect(await readSelectOptions("Role")).toEqual(["None", "Viewer", "Editor"])
  })

  test("reports the picked value, also for an option whose value is empty", async () => {
    const onValueChange = vi.fn()
    render(<Select aria-label="Role" value={"viewer" as Role} options={OPTIONS} onValueChange={onValueChange} />)

    await pickSelectOption("Role", "Editor")
    expect(onValueChange).toHaveBeenLastCalledWith("editor")

    await pickSelectOption("Role", "None")
    expect(onValueChange).toHaveBeenLastCalledWith("")
  })

  test("shows the placeholder when the value matches no option", () => {
    render(
      <Select aria-label="Team" value="" options={[{ value: "t1", label: "CoderOne" }]} onValueChange={vi.fn()} placeholder="Pick a team" />,
    )

    expect(selectedLabel("Team")).toBe("Pick a team")
  })
})
