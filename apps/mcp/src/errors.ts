import type { OAuthScope } from "@doxahq/contracts/agent-access";
import type { ValidationIssue } from "@doxahq/contracts/validation";
import {
  CreateCustomDocsDomainError,
  type CreateCustomDocsDomainErrorCode,
} from "@doxahq/api/repositories/docs-domains";
import { ActiveGenerationConflictError } from "@doxahq/api/repositories/jobs";
import {
  CreateProjectError,
  type CreateProjectErrorCode,
} from "@doxahq/api/repositories/projects";
import {
  ProjectDeletionError,
  type ProjectDeletionErrorCode,
} from "@doxahq/api/repositories/project-deletion";
import type { AccessDenialReason } from "@doxahq/api/services/agent-access/project-access-policy";
import { DocsBranchValidationError } from "@doxahq/api/services/docs-branches/management";
import { SyncValidationError } from "@doxahq/api/services/docs-branches/sync";
import {
  DocsContentError,
  type DocsContentErrorCode,
} from "@doxahq/api/services/docs-content/errors";
import { DocsDomainProvisioningError } from "@doxahq/api/services/docs-domain-lifecycle";
import { SiteConfigValidationError } from "@doxahq/api/services/site-config-validation";
import {
  AiAdmissionError,
  CreditsExhaustedError,
  PlanLimitError,
} from "@doxahq/api/services/billing/mcp-billing";
import { RATE_LIMIT_RETRY_AFTER_SECONDS } from "./rate-limit";
import { describeDocsContentError, describeDenial } from "./error-messages";
import { PlatformActionError } from "./services/platform-actions";

export type ToolErrorCode =
  | AccessDenialReason
  | "insufficient_scope"
  | "rate_limited"
  | DocsContentErrorCode
  | "validation_failed"
  | "mdx_invalid"
  | CreateProjectErrorCode
  | ProjectDeletionErrorCode
  | CreateCustomDocsDomainErrorCode
  | "domain_provider_error"
  | "generation_active"
  | BillingToolErrorCode
  | ActionToolErrorCode
  | "internal_error";

/**
 * Billing spec 9.3, 10.6 and 15.3: the HTTP 402 and 403 billing answers as
 * tool errors, with the same facts and a hint.
 */
export type BillingToolErrorCode = "plan_limit" | "credits_exhausted" | "ai_paused_for_review" | "ai_unavailable";

/** Codes that agents can act on when doxa-api refuses an action. */
export type ActionToolErrorCode =
  | "action_denied"
  | "action_failed"
  | "request_not_found"
  | "request_not_pending"
  | "request_rejected"
  | "request_expired"
  | "stale";

export type ToolErrorDetails = Record<string, string | number | boolean>;

export interface ToolErrorBody {
  code: ToolErrorCode;
  /** One or two sentences for the agent. */
  message: string;
  /** The next step, for example "Call list_branches first." */
  hint?: string;
  issues?: ValidationIssue[];
  details?: ToolErrorDetails;
  /** Matches the log line of the call. */
  requestId: string;
}

/** The policy refused the actor on the project. */
export class AccessDeniedError extends Error {
  constructor(readonly reason: AccessDenialReason) {
    super(`Access denied: ${reason}`);
    this.name = "AccessDeniedError";
  }
}

/** A record inside an authorized project does not exist. */
export class ToolNotFoundError extends Error {
  constructor(
    readonly subject: string,
    readonly hint?: string,
  ) {
    super(`${subject} not found.`);
    this.name = "ToolNotFoundError";
  }
}

/** The token lacks the scope of the tool (the runner's own check). */
export class MissingToolScopeError extends Error {
  constructor(readonly requiredScope: OAuthScope) {
    super(`The token does not have the ${requiredScope} scope.`);
    this.name = "MissingToolScopeError";
  }
}

export class ToolRateLimitedError extends Error {
  constructor() {
    super("Rate limited.");
    this.name = "ToolRateLimitedError";
  }
}

/** A page source failed the renderer's MDX parser (spec 10.6). */
export class MdxInvalidError extends Error {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super("The page source is not valid MDX.");
    this.name = "MdxInvalidError";
  }
}

/**
 * Keeps the code and message of the wrapped error but replaces its hint,
 * when the tool knows a better next step than the generic one.
 */
export class HintedToolError extends Error {
  constructor(
    readonly inner: unknown,
    readonly hint: string,
  ) {
    super(inner instanceof Error ? inner.message : "Tool error.");
    this.name = "HintedToolError";
  }
}

type ErrorFields = Omit<ToolErrorBody, "requestId">;

/** The only place that turns an exception into a tool error (spec 9.6). Pure. */
export function mapToolError(error: unknown, requestId: string): ToolErrorBody {
  return { ...describeError(error), requestId };
}

function describeError(error: unknown): ErrorFields {
  if (error instanceof HintedToolError) {
    return { ...describeError(error.inner), hint: error.hint };
  }
  return (
    describeAccessError(error) ??
    describeValidationError(error) ??
    describeServiceError(error) ??
    describeBillingError(error) ??
    describePlatformActionError(error) ?? {
      code: "internal_error",
      message: "Doxa could not complete the request. Try again later.",
      hint: "Report the requestId if the error repeats.",
    }
  );
}

function describeAccessError(error: unknown): ErrorFields | null {
  if (error instanceof AccessDeniedError) return describeDenial(error.reason);
  if (error instanceof ToolNotFoundError) {
    return {
      code: "not_found",
      message: error.message,
      ...(error.hint ? { hint: error.hint } : {}),
    };
  }
  if (error instanceof MissingToolScopeError) {
    return {
      code: "insufficient_scope",
      message: `This connection does not have the ${error.requiredScope} permission.`,
      hint: "Ask the user to reconnect Doxa and grant this permission.",
      details: { requiredScope: error.requiredScope },
    };
  }
  if (error instanceof ToolRateLimitedError) {
    return {
      code: "rate_limited",
      message: "Too many requests from this connection.",
      hint: `Wait ${RATE_LIMIT_RETRY_AFTER_SECONDS} seconds, then retry.`,
      details: { retryAfterSeconds: RATE_LIMIT_RETRY_AFTER_SECONDS },
    };
  }
  return null;
}

function describeValidationError(error: unknown): ErrorFields | null {
  if (
    error instanceof SiteConfigValidationError ||
    error instanceof DocsBranchValidationError ||
    error instanceof SyncValidationError
  ) {
    return {
      code: "validation_failed",
      message: error.message,
      hint: "Fix the listed issues, then retry.",
      issues: [...error.issues],
    };
  }
  if (error instanceof MdxInvalidError) {
    return {
      code: "mdx_invalid",
      message: error.message,
      hint: "Fix the MDX at the reported position, then retry.",
      issues: [...error.issues],
    };
  }
  return null;
}

function describeServiceError(error: unknown): ErrorFields | null {
  if (error instanceof DocsContentError) return describeDocsContentError(error);
  if (
    error instanceof CreateProjectError ||
    error instanceof ProjectDeletionError ||
    error instanceof CreateCustomDocsDomainError
  ) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof DocsDomainProvisioningError) {
    return { code: "domain_provider_error", message: error.message };
  }
  if (error instanceof ActiveGenerationConflictError) {
    return {
      code: "generation_active",
      message: error.message,
      hint: "Call get_generation to follow the running generation.",
    };
  }
  return null;
}

const BILLING_HINT = "Ask the user to open Billing in the Doxa dashboard. No tool buys or changes a plan.";

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** The plan limits of the docs site: what the agent can do before the user upgrades. */
const STORAGE_LIMIT_ERRORS: Readonly<Record<string, { message: (limit: number) => string; hint: string }>> = {
  "docs.branches_per_site": {
    message: (limit) => `The site has all ${String(limit)} branches that its plan allows.`,
    hint: "Reuse an existing branch, or ask the user to erase one or upgrade the plan in the Doxa dashboard.",
  },
  "docs.storage_bytes": {
    message: (limit) => `This image would take the docs over the ${megabytes(limit)} of storage that the plan allows.`,
    hint: "Use smaller images, or ask the user to upgrade the plan in the Doxa dashboard.",
  },
  "site.asset_bytes": {
    message: (limit) => `This file would take the site files over the ${megabytes(limit)} that the plan allows.`,
    hint: "Use a smaller file, or ask the user to upgrade the plan in the Doxa dashboard.",
  },
  "site.asset_files": {
    message: (limit) => `The site has all ${String(limit)} files that its plan allows.`,
    hint: "Ask the user to upgrade the plan in the Doxa dashboard.",
  },
  "site.custom_domains": {
    message: (limit) => `The project has all ${String(limit)} custom domains that its plan allows.`,
    hint: "Ask the user to remove a domain or upgrade the plan in the Doxa dashboard.",
  },
};

function describeBillingError(error: unknown): ErrorFields | null {
  if (error instanceof PlanLimitError) {
    const { key, limit, used, resetsAt } = error.details;
    const details: ToolErrorDetails = { key, limit: typeof limit === "boolean" ? String(limit) : limit };
    if (used !== null) details.used = used;
    if (resetsAt) details.resetsAt = resetsAt.toISOString();
    if (key === "mcp.tool_calls_per_day") {
      return {
        code: "plan_limit",
        message: `The account used all ${String(limit)} tool calls of today.`,
        hint: resetsAt ? `Wait until ${resetsAt.toISOString()}, or upgrade the plan in the Doxa dashboard.` : BILLING_HINT,
        details,
      };
    }
    const storage = STORAGE_LIMIT_ERRORS[key];
    if (storage && typeof limit === "number") {
      return { code: "plan_limit", message: storage.message(limit), hint: storage.hint, details };
    }
    return { code: "plan_limit", message: `The account's plan does not allow ${key}.`, hint: BILLING_HINT, details };
  }
  if (error instanceof CreditsExhaustedError) {
    const { available, needed, reason, resetsAt } = error.details;
    const details: ToolErrorDetails = { available, needed, reason };
    if (resetsAt) details.resetsAt = resetsAt.toISOString();
    return {
      code: "credits_exhausted",
      message: `Not enough AI credits: ${available} available, ${needed} needed.`,
      hint: BILLING_HINT,
      details,
    };
  }
  if (error instanceof AiAdmissionError) {
    return error.code === "ai_paused_for_review"
      ? { code: "ai_paused_for_review", message: "AI runs of this account are paused for a review.", hint: "Ask the user to contact Doxa support." }
      : { code: "ai_unavailable", message: "AI runs are not available right now.", hint: "Try again later." };
  }
  return null;
}

/** The billing codes that the actions RPC carries; its message already holds the facts. */
const BILLING_ACTION_CODES: Readonly<Record<string, BillingToolErrorCode>> = {
  plan_limit: "plan_limit",
  credits_exhausted: "credits_exhausted",
  ai_paused_for_review: "ai_paused_for_review",
  model_unpriced: "ai_unavailable",
};

const ACCESS_DENIAL_CODES: ReadonlySet<string> = new Set<AccessDenialReason>([
  "not_found",
  "scope_missing",
  "project_not_in_grant",
  "forbidden",
]);

const STALE_CODES: ReadonlySet<string> = new Set([
  "branch_gone",
  "revision_changed",
  "branch_behind",
  "main_moved",
  "domain_gone",
  "project_gone",
  "generation_active",
]);

/** doxa-api already wrote a safe message; keep it and map the code. */
function describePlatformActionError(error: unknown): ErrorFields | null {
  if (!(error instanceof PlatformActionError)) return null;
  if (isAccessDenialReason(error.code)) return describeDenial(error.code);
  if (error.code === "action_denied") {
    return { code: "action_denied", message: error.message, hint: "Ask the user to run this action in the Doxa dashboard." };
  }
  if (error.code === "request_not_found" || error.code === "request_not_pending") {
    return { code: error.code, message: error.message };
  }
  if (STALE_CODES.has(error.code)) {
    return { code: "stale", message: error.message, details: { reason: error.code } };
  }
  if (error.code === "internal_error") return null;
  const billingCode = BILLING_ACTION_CODES[error.code];
  if (billingCode) {
    return {
      code: billingCode,
      message: error.message,
      hint: billingCode === "ai_unavailable" ? "Try again later." : BILLING_HINT,
    };
  }
  // A blocked publish: the message names the pages, the hint says how to fix them.
  if (error.code === "mdx_invalid") {
    return describeDocsContentError(new DocsContentError("mdx_invalid", error.message));
  }
  return { code: "action_failed", message: error.message, details: { reason: error.code } };
}

function isAccessDenialReason(code: string): code is AccessDenialReason {
  return ACCESS_DENIAL_CODES.has(code);
}
