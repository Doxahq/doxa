import { z } from "zod";
import { defineEmailKind, type EmailKindProps } from "./define-email-kind";
import { displayName, emailLink, notificationFields } from "./fields";

/** `actionSummary` is one line that names the action, for example "Publish branch agent-fix-links". */
const actionSummary = z.string().trim().min(1).max(200);

export const approvalRequestedEmail = defineEmailKind({
  name: "approval-requested",
  category: "approvals",
  props: z.object({
    ...notificationFields,
    projectName: displayName,
    actionSummary,
    requesterName: displayName,
    agentName: displayName,
    reviewUrl: emailLink,
  }),
});

export const approvalDecidedEmail = defineEmailKind({
  name: "approval-decided",
  category: "approvals",
  props: z.object({
    ...notificationFields,
    projectName: displayName,
    actionSummary,
    decision: z.enum(["approved", "rejected"]),
    deciderName: displayName,
    requestUrl: emailLink,
  }),
});

export const generationFinishedEmail = defineEmailKind({
  name: "generation-finished",
  category: "generations",
  props: z.object({
    ...notificationFields,
    projectName: displayName,
    outcome: z.enum(["succeeded", "failed"]),
    generationUrl: emailLink,
    /** A short reason for a failure, already safe to show to the user. */
    failureReason: z.string().trim().min(1).max(300).optional(),
  }),
});

export const domainStatusChangedEmail = defineEmailKind({
  name: "domain-status-changed",
  category: "domains",
  props: z.object({
    ...notificationFields,
    projectName: displayName,
    hostname: z.string().trim().min(1).max(253),
    status: z.enum(["active", "failed"]),
    domainsUrl: emailLink,
    failureReason: z.string().trim().min(1).max(300).optional(),
  }),
});

export type ApprovalRequestedEmailProps = EmailKindProps<typeof approvalRequestedEmail>;
export type ApprovalDecidedEmailProps = EmailKindProps<typeof approvalDecidedEmail>;
export type GenerationFinishedEmailProps = EmailKindProps<typeof generationFinishedEmail>;
export type DomainStatusChangedEmailProps = EmailKindProps<typeof domainStatusChangedEmail>;
