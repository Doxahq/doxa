// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import type { DocsContentMdxReport, DocsPageMdxIssues } from "@doxahq/contracts"
import { afterEach, describe, expect, test, vi } from "vitest"

import { PageMdxIssues } from "~/components/dashboard/content/page-mdx-issues"
import {
  formatIssueLine,
  issuesForPage,
  sourceOffset,
  withSavedPageIssues,
} from "~/lib/dashboard/mdx-issues"

afterEach(cleanup)

function page(href: string, sourcePath: string, line = 3): DocsPageMdxIssues {
  return { href, sourcePath, issues: [{ line, column: 1, message: "Unknown MDX component: Bogus" }] }
}

describe("MDX issue helpers", () => {
  const report: DocsContentMdxReport = {
    pages: [page("/a", "source/a/index.mdx"), page("/c", "source/c/index.mdx")],
  }

  test("finds the issues of one page", () => {
    expect(issuesForPage(report, "/a")).toEqual(report.pages[0]?.issues)
    expect(issuesForPage(report, "/b")).toEqual([])
    expect(issuesForPage(undefined, "/a")).toEqual([])
    expect(issuesForPage(report, null)).toEqual([])
  })

  test("replaces the saved pages and keeps the others in path order", () => {
    const fixedA = withSavedPageIssues(report, ["/a"], [])
    expect(fixedA.pages.map((item) => item.href)).toEqual(["/c"])

    const brokenB = withSavedPageIssues(report, ["/b"], [page("/b", "source/b/index.mdx", 9)])
    expect(brokenB.pages.map((item) => item.href)).toEqual(["/a", "/b", "/c"])

    const movedLine = withSavedPageIssues(report, ["/c"], [page("/c", "source/c/index.mdx", 12)])
    expect(issuesForPage(movedLine, "/c")[0]?.line).toBe(12)
  })

  test("turns a line and column into an editor offset", () => {
    const source = "one\ntwo\nthree"
    expect(sourceOffset(source, 1)).toBe(0)
    expect(sourceOffset(source, 2, 2)).toBe(5)
    expect(sourceOffset(source, 3, 99)).toBe(source.length)
    expect(sourceOffset(source, 40)).toBe(source.length)
  })

  test("labels the line", () => {
    expect(formatIssueLine({ line: 7, column: 1, message: "x" })).toBe("Line 7")
    expect(formatIssueLine({ line: null, column: null, message: "x" })).toBe("Unknown line")
  })
})

describe("page MDX issues", () => {
  test("renders nothing for a valid page", () => {
    const view = render(<PageMdxIssues issues={[]} />)
    expect(view.container.innerHTML).toBe("")
  })

  test("lists each issue with its line, and jumps to a line on click", () => {
    const onSelect = vi.fn()
    const issues = [
      { line: 7, column: 1, message: "Unknown MDX component: Bogus" },
      { line: null, column: null, message: "The parser rejected it" },
    ]
    render(<PageMdxIssues issues={issues} onSelect={onSelect} />)

    const region = screen.getByRole("region", { name: "MDX issues" })
    expect(within(region).getByText("Saved. Fix before you publish.")).toBeTruthy()
    const rows = within(region).getAllByRole("listitem")
    expect(rows.map((row) => row.textContent)).toEqual([
      "Line 7Unknown MDX component: Bogus",
      "Unknown lineThe parser rejected it",
    ])
    // An issue without a line has nowhere to jump, so it is not a button.
    expect(within(region).getAllByRole("button")).toHaveLength(1)

    fireEvent.click(within(region).getByRole("button", { name: /Line 7/ }))
    expect(onSelect).toHaveBeenCalledWith(issues[0])
  })
})
