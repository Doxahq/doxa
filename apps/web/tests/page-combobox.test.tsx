// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { DocsContentNavigationSectionDto, DocsContentPageDto } from "@doxahq/contracts"

import { PageCombobox } from "~/components/dashboard/content/site-settings/fields/page-combobox"

beforeEach(() => {
  // Radix and cmdk read these browser APIs. jsdom has no layout.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Element.prototype.scrollIntoView ??= () => undefined
})

afterEach(cleanup)

const page = (href: string, title: string): DocsContentPageDto => ({ href, title, status: "published", sourcePath: "", icon: null })
const pages = [page("/", "Introduction"), page("/quickstart", "Quickstart"), page("/rest-api/webhooks", "Create a webhook")]
const navigation: DocsContentNavigationSectionDto[] = [
  { slug: "default", label: "Docs", isDefault: true, groups: [{ heading: null, groupIndex: null, hrefs: ["/", "/quickstart"] }] },
  { slug: "rest-api", label: "REST API", isDefault: false, groups: [{ heading: "Webhooks", groupIndex: 0, hrefs: ["/rest-api/webhooks"] }] },
]

async function openCombobox(value = "", onValueChange = vi.fn()) {
  render(
    <PageCombobox
      label="Default page"
      value={value}
      pages={pages}
      navigation={navigation}
      noneLabel="First page (Introduction)"
      onValueChange={onValueChange}
    />,
  )
  await act(async () => {
    fireEvent.click(screen.getByRole("combobox", { name: "Default page" }))
  })
  return onValueChange
}

function search(text: string) {
  fireEvent.change(screen.getByPlaceholderText("Search pages…"), { target: { value: text } })
}

const optionTitles = () => screen.queryAllByRole("option").map((option) => option.textContent ?? "")

describe("the page combobox", () => {
  test("shows the chosen page title and URL on the button", () => {
    render(
      <PageCombobox label="Default page" value="/quickstart" pages={pages} navigation={navigation} noneLabel="First page" onValueChange={vi.fn()} />,
    )
    expect(screen.getByRole("combobox").textContent).toBe("Quickstart/quickstart")
  })

  test("lists the first page choice, then every page by section", async () => {
    await openCombobox()
    expect(optionTitles()).toEqual([
      "First page (Introduction)",
      "Introduction/",
      "Quickstart/quickstart",
      "Create a webhook/rest-api/webhooks",
    ])
    expect(screen.getByText("REST API")).toBeTruthy()
  })

  test("filters by title or URL as the user types", async () => {
    await openCombobox()
    search("webhook")
    expect(optionTitles()).toEqual(["Create a webhook/rest-api/webhooks"])
    search("quick")
    expect(optionTitles()).toEqual(["Quickstart/quickstart"])
    search("nothing like this")
    expect(screen.getByText("No page matches.")).toBeTruthy()
  })

  test("Enter picks the highlighted match", async () => {
    const onValueChange = await openCombobox()
    search("webhook")
    fireEvent.keyDown(screen.getByPlaceholderText("Search pages…"), { key: "Enter" })
    expect(onValueChange).toHaveBeenCalledWith("/rest-api/webhooks")
  })

  test("only the chosen page has a check mark", async () => {
    await openCombobox("/quickstart")
    const checked = screen.getAllByRole("option").filter((option) => option.querySelector("svg"))
    expect(checked.map((option) => option.textContent)).toEqual(["Quickstart/quickstart"])
  })

  test("the first page choice clears the value", async () => {
    const onValueChange = await openCombobox("/quickstart")
    fireEvent.click(screen.getByRole("option", { name: /First page/ }))
    expect(onValueChange).toHaveBeenCalledWith("")
  })
})
