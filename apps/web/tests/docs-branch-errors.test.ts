import { describe, expect, test } from "vitest"

import { ApiRequestError } from "~/lib/api-errors"
import { isMissingPageError, isUnpublishedSiteError } from "~/lib/dashboard/docs-branch-errors"

describe("missing page errors", () => {
  test("treat a page that is gone as no error", () => {
    expect(isMissingPageError(new ApiRequestError("No page exists at /dashboard.", 404, "not_found"))).toBe(true)
    expect(isMissingPageError(new ApiRequestError("No page exists at /dashboard.", 404, null))).toBe(true)
  })

  test("still report a missing branch and other failures", () => {
    expect(isMissingPageError(new ApiRequestError("Branch not found.", 404, "branch_not_found"))).toBe(false)
    expect(isMissingPageError(new ApiRequestError("Server error", 500, null))).toBe(false)
    expect(isMissingPageError(new Error("Network"))).toBe(false)
  })
})

describe("unpublished site errors", () => {
  const missingBranch = new ApiRequestError("Branch not found.", 404, "branch_not_found")

  test("treat a missing main branch as a site without a published version", () => {
    expect(isUnpublishedSiteError(missingBranch, "main")).toBe(true)
  })

  test("still report an erased branch and other failures", () => {
    expect(isUnpublishedSiteError(missingBranch, "01HZX0000000000000000000AB")).toBe(false)
    expect(isUnpublishedSiteError(new ApiRequestError("Server error", 500, null), "main")).toBe(false)
    expect(isUnpublishedSiteError(new Error("Network"), "main")).toBe(false)
  })
})
