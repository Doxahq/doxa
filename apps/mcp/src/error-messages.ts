import type { AccessDenialReason } from "@doxahq/api/services/agent-access/project-access-policy";
import type {
  DocsContentError,
  DocsContentErrorCode,
} from "@doxahq/api/services/docs-content/errors";
import type { ToolErrorBody, ToolErrorDetails } from "./errors";

type ErrorFields = Omit<ToolErrorBody, "requestId">;

const DENIALS: Record<AccessDenialReason, Omit<ErrorFields, "code">> = {
  not_found: {
    message: "Project not found.",
    hint: "Call list_projects to see the projects this connection can use.",
  },
  scope_missing: {
    message: "This connection does not have the permission for this tool.",
    hint: "Ask the user to reconnect Doxa and grant the permission.",
  },
  project_not_in_grant: {
    message: "This connection is not allowed to use this project.",
    hint: "Ask the user to reconnect Doxa and select this project.",
  },
  forbidden: {
    message: "The user's role on this project does not allow this action.",
  },
};

export function describeDenial(reason: AccessDenialReason): ErrorFields {
  return { code: reason, ...DENIALS[reason] };
}

const DOCS_CONTENT_HINTS: Partial<Record<DocsContentErrorCode, string>> = {
  not_found: "Call get_docs_structure to see the pages.",
  branch_not_found: "Call list_branches to see the branches.",
  conflict: "Read the content again, then retry with the current revision.",
  branch_behind: "Call sync_branch to bring the branch up to date.",
  main_changed: "Read the main branch again, then retry.",
  conflicts_unresolved: "Resolve the conflicts with sync_branch first.",
  preview_rate_limited: "Wait a minute before you build another preview.",
  publish_pending:
    "Call cancel_approval_request with details.requestId, then call delete_branch again.",
  asset_invalid:
    "Send a PNG, JPEG, WebP, GIF, or SVG file. With upload_asset, send it as standard base64 without a data: prefix.",
  asset_too_large: "Send a file of 2 MB or less, for example a resized or compressed image.",
  asset_upload_not_found:
    "Call create_asset_upload for a new upload URL, send the file to it with PUT, then call finish_asset_upload.",
  asset_upload_limit_reached:
    "Call finish_asset_upload for the uploads you started, or wait details.retryAfterSeconds for one to expire, then call create_asset_upload again. details.scope says whether this connection or this member is at the limit.",
  asset_upload_busy: "Send the same call again in a moment.",
  asset_upload_not_sent:
    "Send the file to uploadUrl with an HTTP PUT first (the curl command of create_asset_upload), then call finish_asset_upload again.",
  asset_limit_reached:
    "Publish this branch, or reuse an image path that the branch already has.",
  storage_quota_exceeded:
    "Use smaller images, or ask the user to free storage on the plan.",
  mdx_invalid:
    "Read each listed page with read_page, fix it with write_page, then call publish_branch again.",
};

export function describeDocsContentError(error: DocsContentError): ErrorFields {
  const hint = DOCS_CONTENT_HINTS[error.code];
  const details = toDetails(error.details);
  return {
    code: error.code,
    message: error.message,
    ...(hint ? { hint } : {}),
    ...(details ? { details } : {}),
  };
}

/** Keeps only flat scalar fields, so no nested service data leaks out. */
export function toDetails(value: unknown): ToolErrorDetails | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const details: ToolErrorDetails = {};
  for (const [key, field] of Object.entries(value)) {
    if (
      typeof field === "string" ||
      typeof field === "number" ||
      typeof field === "boolean"
    ) {
      details[key] = field;
    }
  }
  return Object.keys(details).length > 0 ? details : undefined;
}
