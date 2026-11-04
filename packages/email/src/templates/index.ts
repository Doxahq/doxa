import { isEmailKindName, type EmailKindName } from "../catalog";
import type { EmailTemplate } from "./define-email-template";
import {
  approvalDecidedTemplate,
  approvalRequestedTemplate,
  domainStatusChangedTemplate,
  generationFinishedTemplate,
} from "./notifications";
import { resetPasswordTemplate, verifyEmailTemplate } from "./account";
import { teamInviteTemplate } from "./team-invite";

export {
  defineEmailTemplate,
  renderEmailTemplate,
  type EmailTemplate,
  type RenderedEmail,
} from "./define-email-template";
export {
  approvalDecidedTemplate,
  approvalRequestedTemplate,
  domainStatusChangedTemplate,
  generationFinishedTemplate,
} from "./notifications";
export { resetPasswordTemplate, verifyEmailTemplate } from "./account";
export { teamInviteTemplate } from "./team-invite";

/** One template for each email kind. The compiler fails when a kind has no template. */
export const EMAIL_TEMPLATES = {
  "team-invite": teamInviteTemplate,
  "approval-requested": approvalRequestedTemplate,
  "approval-decided": approvalDecidedTemplate,
  "generation-finished": generationFinishedTemplate,
  "domain-status-changed": domainStatusChangedTemplate,
  "verify-email": verifyEmailTemplate,
  "reset-password": resetPasswordTemplate,
} as const satisfies Record<EmailKindName, EmailTemplate>;

/** Finds the template for a kind name read from storage, such as an outbox row. */
export function findEmailTemplate(kindName: string): EmailTemplate | undefined {
  return isEmailKindName(kindName) ? EMAIL_TEMPLATES[kindName] : undefined;
}
