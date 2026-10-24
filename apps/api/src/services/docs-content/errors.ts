export type DocsContentErrorCode =
  | "not_found"
  | "conflict"
  | "invalid"
  | "no_changes"
  | "branch_not_found"
  | "branch_behind"
  | "main_changed"
  | "conflicts_unresolved"
  | "preview_rate_limited"
  | "publish_pending"
  | "asset_invalid"
  | "asset_too_large"
  | "asset_limit_reached"
  | "storage_quota_exceeded"
  /** A changed page on the branch fails the MDX check, so it cannot go live. */
  | "mdx_invalid"
  /** A review decision would remove a page that a person edited on the branch. */
  | "page_edited";

export class DocsContentError extends Error {
  constructor(
    readonly code: DocsContentErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "DocsContentError";
  }
}

export function getDocsContentErrorStatus(code: DocsContentErrorCode): number {
  switch (code) {
    case "not_found":
    case "branch_not_found":
      return 404;
    case "conflict":
    case "branch_behind":
    case "main_changed":
    case "conflicts_unresolved":
    case "publish_pending":
    case "page_edited":
      return 409;
    case "no_changes":
    case "asset_limit_reached":
    case "storage_quota_exceeded":
    case "mdx_invalid":
      return 422;
    case "asset_too_large":
      return 413;
    case "preview_rate_limited":
      return 429;
    case "invalid":
    case "asset_invalid":
      return 400;
  }
}
