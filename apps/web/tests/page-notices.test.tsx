// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { PageNotice } from "@doxahq/contracts/generation-reviews"
import { afterEach, describe, expect, test, vi } from "vitest"

import { ReviewPageNotices } from "~/components/dashboard/content/review/review-page-notices"
import { pageNoticeDetail, pageNoticeSummary, readPageNotices } from "~/lib/dashboard/page-notices"

afterEach(cleanup)

const kept: PageNotice = {
  pageId: "documentation/guide",
  title: "Guide",
  href: "/guide",
  kind: "open_issues",
  issues: [
    { check: "instructionTerminology", message: 'Say "repository", not "repo".', instructions: true },
    { check: "cutoffContent", message: "Content appears cut off.", instructions: false },
  ],
}
const behind: PageNotice = {
  pageId: "documentation/faq",
  title: "FAQ",
  href: null,
  kind: "behind_instructions",
  issues: [],
}

describe("page notices", () => {
  test("the review opens a page with a notice, and its tooltip lists the issues", () => {
    const onSelect = vi.fn()
    render(<ReviewPageNotices notices={[kept, behind]} focusHref={null} onSelect={onSelect} />)

    const button = screen.getByRole("button", { name: /Guide/ })
    fireEvent.click(button)
    expect(onSelect).toHaveBeenCalledWith("/guide")
    expect(button.getAttribute("title")).toBe(
      'This page may not follow the Doxabot instructions.\nSay "repository", not "repo".\nContent appears cut off.',
    )
    expect(screen.getByText("1 instruction issue")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /FAQ/ })).toBeNull()
    expect(screen.getByText("Not updated to the instructions")).toBeTruthy()
  })

  test("words each kind of notice", () => {
    expect(pageNoticeDetail(behind)).toBe(
      "Doxabot could not update this page to the current Doxabot instructions after 3 attempts, so it keeps its published version. Check it, or edit it to follow the instructions.",
    )
    expect(pageNoticeSummary({ ...kept, issues: [kept.issues[1]!] })).toBe("1 open issue")
    expect(pageNoticeDetail({ ...kept, issues: [kept.issues[1]!] })).toBe(
      "Doxabot kept this page with issues it could not fix.\nContent appears cut off.",
    )
  })

  test("an older API without notices renders nothing", () => {
    expect(readPageNotices({})).toEqual([])
    const { container } = render(<ReviewPageNotices notices={[]} focusHref={null} onSelect={() => {}} />)
    expect(container.innerHTML).toBe("")
  })
})
