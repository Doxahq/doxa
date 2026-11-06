import type { BranchRef } from "@doxahq/contracts/docs-branches"

import { ApiRequestError } from "~/lib/api-errors"
import { getErrorMessage } from "~/lib/errors"

/**
 * True for a page that is gone, for example after a review decision or a
 * delete removed it. The editor then opens another page, so it is no error.
 */
export function isMissingPageError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 404 && error.code !== "branch_not_found"
}

/**
 * True when the site has no published version yet, so `main` does not exist.
 * The content page shows this as its empty state, so it is no error.
 */
export function isUnpublishedSiteError(error: unknown, branch: BranchRef): boolean {
  return branch === "main" && error instanceof ApiRequestError && error.code === "branch_not_found"
}

export function getDocsBranchErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError && error.code === "branch_not_found") {
    return "This branch was published and erased."
  }
  return getErrorMessage(error, fallback)
}
