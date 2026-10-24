import { ApprovalDecidedEmail } from "../../emails/approval-decided";
import { ApprovalRequestedEmail } from "../../emails/approval-requested";
import { DomainStatusChangedEmail } from "../../emails/domain-status-changed";
import { GenerationFinishedEmail } from "../../emails/generation-finished";
import {
  approvalDecidedEmail,
  approvalRequestedEmail,
  domainStatusChangedEmail,
  generationFinishedEmail,
} from "../catalog/notifications";
import { defineEmailTemplate } from "./define-email-template";

export const approvalRequestedTemplate = defineEmailTemplate(approvalRequestedEmail, {
  subject: ({ projectName, actionSummary }) => `Approval needed in ${projectName}: ${actionSummary}`,
  render: (props) => <ApprovalRequestedEmail {...props} />,
});

export const approvalDecidedTemplate = defineEmailTemplate(approvalDecidedEmail, {
  subject: ({ projectName, decision }) => `Your agent's request in ${projectName} was ${decision}`,
  render: (props) => <ApprovalDecidedEmail {...props} />,
});

export const generationFinishedTemplate = defineEmailTemplate(generationFinishedEmail, {
  subject: ({ projectName, outcome }) =>
    outcome === "succeeded" ? `Your docs for ${projectName} are ready` : `The generation for ${projectName} failed`,
  render: (props) => <GenerationFinishedEmail {...props} />,
});

export const domainStatusChangedTemplate = defineEmailTemplate(domainStatusChangedEmail, {
  subject: ({ hostname, status }) => (status === "active" ? `${hostname} is live` : `${hostname} needs attention`),
  render: (props) => <DomainStatusChangedEmail {...props} />,
});
