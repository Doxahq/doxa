import type { PageNotice } from "@doxahq/contracts/generation-reviews"
import { MAX_INSTRUCTION_CATCH_UP_ATTEMPTS } from "@doxahq/contracts/generation-state"

/** An older API sends no page notices; that reads as none. */
export function readPageNotices(source: { pageNotices?: readonly PageNotice[] }): readonly PageNotice[] {
  return source.pageNotices ?? []
}

/** The short line under a page in the review list. */
export function pageNoticeSummary(notice: PageNotice): string {
  if (notice.kind === "behind_instructions") return "Not updated to the instructions"
  const instructionIssues = notice.issues.filter((issue) => issue.instructions).length
  if (instructionIssues > 0) {
    return instructionIssues === 1 ? "1 instruction issue" : `${instructionIssues} instruction issues`
  }
  return notice.issues.length === 1 ? "1 open issue" : `${notice.issues.length} open issues`
}

/** What the review tells the owner about the page, for its tooltip. */
export function pageNoticeDetail(notice: PageNotice): string {
  if (notice.kind === "behind_instructions") {
    return `Doxabot could not update this page to the current Doxabot instructions after ${MAX_INSTRUCTION_CATCH_UP_ATTEMPTS} attempts, so it keeps its published version. Check it, or edit it to follow the instructions.`
  }
  const lead = notice.issues.some((issue) => issue.instructions)
    ? "This page may not follow the Doxabot instructions."
    : "Doxabot kept this page with issues it could not fix."
  return [lead, ...notice.issues.map((issue) => issue.message)].join("\n")
}
