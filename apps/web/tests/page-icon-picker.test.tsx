// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { LUCIDE_ICON_COUNT } from "@doxahq/docs-prose/icons"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { PageIconPicker } from "~/components/dashboard/content/write-editor/page-icon-picker"
import { PropsForm } from "~/components/dashboard/content/write-editor/props-form"
import { loadDocsIcons } from "~/lib/dashboard/docs-icons"
import type { PropField } from "~/lib/editor/component-props"

beforeEach(() => {
  // Radix reads these browser APIs. jsdom has no layout.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Element.prototype.scrollIntoView ??= () => undefined
})

afterEach(cleanup)

async function openPicker(icon: string | null, onChange = vi.fn()) {
  render(<PageIconPicker edit={{ icon, onChange }} disabled={false} />)
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: icon ? /Change icon/ : "Add page icon" }))
  })
  return onChange
}

/** Opens the picker once the full icon set and its search words are loaded. */
async function openLoadedPicker(icon: string | null, onChange = vi.fn()) {
  await act(() => loadDocsIcons({ tags: true }))
  return openPicker(icon, onChange)
}

function searchField(): HTMLElement {
  return screen.getByPlaceholderText("Search icons…")
}

async function search(text: string) {
  await act(async () => {
    fireEvent.change(searchField(), { target: { value: text } })
  })
}

async function press(key: string) {
  await act(async () => {
    fireEvent.keyDown(searchField(), { key })
  })
}

function visibleIcons(): string[] {
  return screen.queryAllByRole("option").map((option) => option.getAttribute("aria-label") ?? "")
}

/** The name of the highlighted icon, under the grid. */
function footer(): string {
  return document.querySelector("[data-slot=icon-picker-highlight]")?.textContent ?? ""
}

// The full icon set is a module-level cache, so the test that sees it still
// loading runs first.
describe("the page icon picker before the full icon set loads", () => {
  test("shows the suggested icons at once, and placeholders for the rest", async () => {
    await openPicker(null)
    expect(document.activeElement).toBe(searchField())
    expect(visibleIcons()).toEqual(expect.arrayContaining(["Rocket", "House", "Terminal", "Circle question mark"]))
    expect(visibleIcons()).toHaveLength(30)
    expect(screen.getByText(/All icons/)).toBeTruthy()

    // Opening the picker loads the full set.
    await waitFor(() => expect(visibleIcons()).toContain("A arrow down"), { timeout: 5000 })
  })
})

describe("the page icon picker", () => {
  test("a page with an icon shows it on the button", () => {
    render(<PageIconPicker edit={{ icon: "rocket", onChange: vi.fn() }} disabled={false} />)
    expect(screen.getByRole("button", { name: "Page icon: Rocket. Change icon" })).toBeTruthy()
  })

  test("a page with a renamed Lucide icon shows its current name", () => {
    render(<PageIconPicker edit={{ icon: "circleHelp", onChange: vi.fn() }} disabled={false} />)
    expect(screen.getByRole("button", { name: "Page icon: Circle question mark. Change icon" })).toBeTruthy()
  })

  test("a page without an icon shows an add button", () => {
    render(<PageIconPicker edit={{ icon: null, onChange: vi.fn() }} disabled={false} />)
    expect(screen.getByRole("button", { name: "Add page icon" })).toBeTruthy()
  })

  test("lists the suggested icons, then every Lucide icon, drawing only the rows in view", async () => {
    await openLoadedPicker(null)
    expect(screen.getByText("Suggested")).toBeTruthy()
    expect(screen.getByRole("listbox").textContent).toContain(
      `All icons · ${LUCIDE_ICON_COUNT.toLocaleString("en-US")}`,
    )
    expect(visibleIcons()).toEqual(expect.arrayContaining(["Rocket", "A arrow down", "A arrow up"]))
    expect(visibleIcons().length).toBeLessThan(120)
  })

  test("the search matches names, Lucide's search words and the suggested words", async () => {
    await openLoadedPicker(null)
    await search("home")
    expect(visibleIcons()).toContain("House")
    await search("gear")
    expect(visibleIcons()).toEqual(expect.arrayContaining(["Cog", "Settings"]))
    await search("anchor")
    expect(visibleIcons()[0]).toBe("Anchor")
    await search("zzzz")
    expect(visibleIcons()).toEqual([])
    expect(screen.getByText("No icon matches.")).toBeTruthy()
  })

  test("choosing any Lucide icon reports it and closes the dropdown", async () => {
    const onChange = await openLoadedPicker(null)
    await search("anchor")
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Anchor" }))
    })
    expect(onChange).toHaveBeenCalledWith("anchor")
    expect(screen.queryByPlaceholderText("Search icons…")).toBeNull()
  })

  test("Enter chooses the best match of a search", async () => {
    const onChange = await openLoadedPicker(null)
    await search("terminal")
    await press("Enter")
    expect(onChange).toHaveBeenCalledWith("terminal")
  })

  test("the arrow keys move through the grid", async () => {
    const onChange = await openLoadedPicker(null)
    await press("ArrowRight")
    await press("ArrowRight")
    expect(footer()).toContain("Arrow up right")
    await press("ArrowDown")
    expect(footer()).toContain("Compass")
    await press("ArrowUp")
    await press("ArrowLeft")
    await press("Enter")
    expect(onChange).toHaveBeenCalledWith("textAlignJustify")
  })

  test("the current icon is highlighted, also when it is not a suggested one", async () => {
    await openLoadedPicker("anchor")
    const current = screen.getByRole("option", { name: "Anchor" })
    expect(current.getAttribute("aria-current")).toBe("true")
    expect(current.getAttribute("aria-selected")).toBe("true")
  })

  test("choosing the current icon changes nothing", async () => {
    const onChange = await openLoadedPicker("rocket")
    await act(async () => {
      fireEvent.click(screen.getAllByRole("option", { name: "Rocket" })[0]!)
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  test("remove clears the icon", async () => {
    const onChange = await openLoadedPicker("rocket")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }))
    })
    expect(onChange).toHaveBeenCalledWith(null)
  })

  test("a page without an icon has no remove button", async () => {
    await openLoadedPicker(null)
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull()
  })

  test("the button is disabled while the editor is read only", () => {
    render(<PageIconPicker edit={{ icon: "rocket", onChange: vi.fn() }} disabled />)
    expect(screen.getByRole("button", { name: /Change icon/ })).toHaveProperty("disabled", true)
  })
})

describe("the card icon field", () => {
  const ICON_FIELD: PropField = { name: "icon", label: "Icon", kind: "icon" }

  test("shows the icon and opens the same picker", async () => {
    await act(() => loadDocsIcons({ tags: true }))
    const onChange = vi.fn()
    render(<PropsForm fields={[ICON_FIELD]} read={() => "bookOpen"} onChange={onChange} />)
    const trigger = screen.getByRole("button", { name: "Icon" })
    expect(trigger.textContent).toContain("Book open")

    await act(async () => {
      fireEvent.click(trigger)
    })
    await search("bird")
    await press("Enter")
    expect(onChange).toHaveBeenCalledWith(ICON_FIELD, "bird")
  })

  test("removing the icon writes an empty value", async () => {
    const onChange = vi.fn()
    render(<PropsForm fields={[ICON_FIELD]} read={() => "bookOpen"} onChange={onChange} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Icon" }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }))
    })
    expect(onChange).toHaveBeenCalledWith(ICON_FIELD, "")
  })
})
