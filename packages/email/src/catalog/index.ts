import type { EmailKind } from "./define-email-kind";
import {
  approvalDecidedEmail,
  approvalRequestedEmail,
  domainStatusChangedEmail,
  generationFinishedEmail,
} from "./notifications";
import { agentConnectedEmail, resetPasswordEmail, verifyEmailEmail } from "./account";
import { teamInviteEmail } from "./team-invite";
import { creditsExhaustedEmail, creditsLowEmail, paygLimitEmail, paygStartedEmail } from "./billing";

export {
  EMAIL_NOTIFICATION_CATEGORIES,
  EMAIL_STREAMS,
  defineEmailKind,
  isNotificationCategory,
  streamOf,
  type EmailCategory,
  type EmailKind,
  type EmailKindProps,
  type EmailNotificationCategory,
  type EmailStream,
} from "./define-email-kind";
export {
  approvalDecidedEmail,
  approvalRequestedEmail,
  domainStatusChangedEmail,
  generationFinishedEmail,
  type ApprovalDecidedEmailProps,
  type ApprovalRequestedEmailProps,
  type DomainStatusChangedEmailProps,
  type GenerationFinishedEmailProps,
} from "./notifications";
export {
  agentConnectedEmail,
  resetPasswordEmail,
  verifyEmailEmail,
  type AgentConnectedEmailProps,
  type ResetPasswordEmailProps,
  type VerifyEmailEmailProps,
} from "./account";
export {
  PAYG_LIMIT_PERCENTS,
  creditsExhaustedEmail,
  creditsLowEmail,
  paygLimitEmail,
  paygStartedEmail,
  type CreditsExhaustedEmailProps,
  type CreditsLowEmailProps,
  type PaygLimitEmailProps,
  type PaygLimitPercent,
  type PaygStartedEmailProps,
} from "./billing";
export { TEAM_INVITE_ROLES, teamInviteEmail, type TeamInviteEmailProps, type TeamInviteRole } from "./team-invite";

/** Every kind of email that Doxa sends. Add a new kind here and its template in `templates/`. */
export const EMAIL_KINDS = [
  teamInviteEmail,
  approvalRequestedEmail,
  approvalDecidedEmail,
  generationFinishedEmail,
  domainStatusChangedEmail,
  verifyEmailEmail,
  resetPasswordEmail,
  agentConnectedEmail,
  creditsLowEmail,
  paygStartedEmail,
  paygLimitEmail,
  creditsExhaustedEmail,
] as const satisfies readonly EmailKind[];

export type EmailKindName = (typeof EMAIL_KINDS)[number]["name"];

export function isEmailKindName(value: string): value is EmailKindName {
  return EMAIL_KINDS.some((kind) => kind.name === value);
}

export function findEmailKind(name: string): EmailKind | undefined {
  return EMAIL_KINDS.find((kind) => kind.name === name);
}
