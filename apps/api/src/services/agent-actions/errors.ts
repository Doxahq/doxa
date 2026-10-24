import type { AgentActionKind } from "@doxahq/contracts/approval-requests";
import type { AccessDenialReason } from "../agent-access/project-access-policy";
import type { StaleReason } from "./freshness";

/** The access policy refused the actor (spec 8.5 step 2). */
export class ActionAccessDeniedError extends Error {
  constructor(readonly reason: AccessDenialReason) {
    super(`Access denied: ${reason}`);
    this.name = "ActionAccessDeniedError";
  }
}

/** The approval policy resolved `deny` (spec 8.5 step 4). */
export class ActionDeniedError extends Error {
  constructor(
    readonly action: AgentActionKind,
    readonly policySource: string,
  ) {
    super("Doxa does not allow agents to run this action.");
    this.name = "ActionDeniedError";
  }
}

/** The payload does not match the action's schema. */
export class ActionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionInputError";
  }
}

/** An allowed action whose preconditions changed between capture and execute. */
export class ActionStaleError extends Error {
  constructor(
    readonly reason: StaleReason,
    message: string,
  ) {
    super(message);
    this.name = "ActionStaleError";
  }
}

/** An action ran and its service refused it, with a code for the agent. */
export class ActionExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ActionExecutionError";
  }
}

/** No request, or the actor may not see it. Never reveals which. */
export class ApprovalRequestNotFoundError extends Error {
  constructor() {
    super("Approval request not found.");
    this.name = "ApprovalRequestNotFoundError";
  }
}

export class RequestNotPendingError extends Error {
  constructor(readonly status: string) {
    super(`The request is ${status}, not pending.`);
    this.name = "RequestNotPendingError";
  }
}

/** The typed confirmation of a destructive action does not match. */
export class ConfirmationMismatchError extends Error {
  constructor() {
    super("Type the project name to approve this action.");
    this.name = "ConfirmationMismatchError";
  }
}

/** A release removed the action kind of this request. */
export class ActionUnavailableError extends Error {
  constructor() {
    super("This action is no longer available.");
    this.name = "ActionUnavailableError";
  }
}

/** A setting names an unknown action, or a mode outside its `allowedModes`. */
export class ApprovalSettingInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalSettingInvalidError";
  }
}

/**
 * The project requires another member to approve (v2 spec §12 question 2):
 * the person whose agent asked cannot approve it. Reject and cancel stay open.
 */
export class OtherDeciderRequiredError extends Error {
  constructor() {
    super("This project needs another member to approve a request from your own agent.");
    this.name = "OtherDeciderRequiredError";
  }
}
