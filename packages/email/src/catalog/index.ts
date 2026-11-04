import type { EmailKind } from "./define-email-kind";
import {
  approvalDecidedEmail,
  approvalRequestedEmail,
  domainStatusChangedEmail,
  generationFinishedEmail,
} from "./notifications";
import { resetPasswordEmail, verifyEmailEmail } from "./account";
import { teamInviteEmail } from "./team-invite";

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
  resetPasswordEmail,
  verifyEmailEmail,
  type ResetPasswordEmailProps,
  type VerifyEmailEmailProps,
} from "./account";
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
] as const satisfies readonly EmailKind[];

export type EmailKindName = (typeof EMAIL_KINDS)[number]["name"];

export function isEmailKindName(value: string): value is EmailKindName {
  return EMAIL_KINDS.some((kind) => kind.name === value);
}

export function findEmailKind(name: string): EmailKind | undefined {
  return EMAIL_KINDS.find((kind) => kind.name === name);
}
