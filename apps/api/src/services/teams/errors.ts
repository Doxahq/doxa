import type { TeamErrorCode, TeamInviteFailure } from "@doxahq/contracts/teams";

/** No team, or the user is not a member. Never reveals which. */
export class TeamNotFoundError extends Error {
  constructor() {
    super("Team not found.");
    this.name = "TeamNotFoundError";
  }
}

/** A member whose role lacks the capability. */
export class TeamAccessError extends Error {
  constructor() {
    super("Your role in this team does not allow this action.");
    this.name = "TeamAccessError";
  }
}

/** A rule of the team refused the change; the code says which. */
export class TeamConflictError extends Error {
  constructor(
    readonly code: TeamErrorCode,
    message: string,
    readonly status: 403 | 409 | 429 = 409,
  ) {
    super(message);
    this.name = "TeamConflictError";
  }
}

const INVITE_MESSAGES: Record<TeamInviteFailure, string> = {
  invite_not_found: "This invite link is not valid.",
  invite_used: "This invite link was already used.",
  invite_expired: "This invite link has expired. Ask for a new one.",
  invite_revoked: "This invite link was revoked. Ask for a new one.",
  already_member: "You are already a member of this team.",
};

/** An invite link that does not work, with the reason for the accept page. */
export class TeamInviteError extends Error {
  constructor(readonly code: TeamInviteFailure) {
    super(INVITE_MESSAGES[code]);
    this.name = "TeamInviteError";
  }
}
