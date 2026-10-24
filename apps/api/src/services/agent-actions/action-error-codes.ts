import type { ApprovalRequestError } from "@doxahq/contracts/approval-requests";
import { toSafeErrorLog } from "../../http/error-log";
import { CreateCustomDocsDomainError } from "../../repositories/docs-domains";
import { ActiveGenerationConflictError } from "../../repositories/jobs";
import { ProjectDeletionError } from "../../repositories/project-deletion";
import { CreateProjectError } from "../../repositories/projects";
import { DocsContentError } from "../docs-content/errors";
import { DocsDomainProvisioningError } from "../docs-domain-lifecycle";
import {
  ActionAccessDeniedError,
  ActionDeniedError,
  ActionExecutionError,
  ActionInputError,
  ActionStaleError,
  ActionUnavailableError,
  ApprovalRequestNotFoundError,
  ConfirmationMismatchError,
  RequestNotPendingError,
} from "./errors";

/**
 * Turns a known error of an action or its services into a code and a
 * message that are safe to store and show. Null for anything else.
 */
export function describeKnownActionError(error: unknown): ApprovalRequestError | null {
  if (error instanceof ActionAccessDeniedError) return { code: error.reason, message: error.message };
  if (error instanceof ActionDeniedError) return { code: "action_denied", message: error.message };
  if (error instanceof ActionStaleError) return { code: error.reason, message: error.message };
  if (error instanceof ActionInputError) return { code: "invalid_input", message: error.message };
  if (error instanceof ApprovalRequestNotFoundError) {
    return { code: "request_not_found", message: error.message };
  }
  if (error instanceof RequestNotPendingError) {
    return { code: "request_not_pending", message: error.message };
  }
  if (error instanceof ConfirmationMismatchError) {
    return { code: "confirmation_mismatch", message: error.message };
  }
  if (error instanceof ActionUnavailableError) return { code: "action_removed", message: error.message };
  return describeServiceError(error);
}

function describeServiceError(error: unknown): ApprovalRequestError | null {
  if (
    error instanceof ActionExecutionError ||
    error instanceof DocsContentError ||
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
    return { code: "generation_active", message: error.message };
  }
  return null;
}

export const INTERNAL_ACTION_ERROR: ApprovalRequestError = {
  code: "internal_error",
  message: "The action failed. Try again later.",
};

/** Never stores an unknown error's text: it can hold internal details. */
export function describeExecutionError(error: unknown): ApprovalRequestError {
  const known = describeKnownActionError(error);
  if (known) return known;
  console.error("Agent action failed.", toSafeErrorLog(error));
  return INTERNAL_ACTION_ERROR;
}
