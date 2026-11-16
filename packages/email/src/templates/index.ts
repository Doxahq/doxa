import { isEmailKindName, type EmailKindName } from "../catalog";
import type { EmailTemplate } from "./define-email-template";
import {
  approvalDecidedTemplate,
  approvalRequestedTemplate,
  domainStatusChangedTemplate,
  generationFinishedTemplate,
} from "./notifications";
import { agentConnectedTemplate, resetPasswordTemplate, verifyEmailTemplate } from "./account";
import { teamInviteTemplate } from "./team-invite";
import { creditsExhaustedTemplate, creditsLowTemplate, paygLimitTemplate, paygStartedTemplate } from "./billing";

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
export { agentConnectedTemplate, resetPasswordTemplate, verifyEmailTemplate } from "./account";
export { teamInviteTemplate } from "./team-invite";
export { creditsExhaustedTemplate, creditsLowTemplate, paygLimitTemplate, paygStartedTemplate } from "./billing";

/** One template for each email kind. The compiler fails when a kind has no template. */
export const EMAIL_TEMPLATES = {
  "team-invite": teamInviteTemplate,
  "approval-requested": approvalRequestedTemplate,
  "approval-decided": approvalDecidedTemplate,
  "generation-finished": generationFinishedTemplate,
  "domain-status-changed": domainStatusChangedTemplate,
  "verify-email": verifyEmailTemplate,
  "reset-password": resetPasswordTemplate,
  "agent-connected": agentConnectedTemplate,
  "credits-low": creditsLowTemplate,
  "payg-started": paygStartedTemplate,
  "payg-limit": paygLimitTemplate,
  "credits-exhausted": creditsExhaustedTemplate,
} as const satisfies Record<EmailKindName, EmailTemplate>;

/** Finds the template for a kind name read from storage, such as an outbox row. */
export function findEmailTemplate(kindName: string): EmailTemplate | undefined {
  return isEmailKindName(kindName) ? EMAIL_TEMPLATES[kindName] : undefined;
}
