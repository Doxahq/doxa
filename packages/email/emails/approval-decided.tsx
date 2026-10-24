import type { ApprovalDecidedEmailProps } from "../src/catalog/notifications";
import { EmailAction, EmailFacts, EmailHeading, EmailParagraph } from "../src/components/email-blocks";
import { EmailLayout } from "../src/components/email-layout";

const DECISION_COPY = {
  approved: { verb: "approved", next: "The action runs now." },
  rejected: { verb: "rejected", next: "The action does not run. Your agent sees the rejection." },
} as const;

export function ApprovalDecidedEmail({
  projectName,
  actionSummary,
  decision,
  deciderName,
  requestUrl,
  unsubscribeUrl,
}: ApprovalDecidedEmailProps) {
  const copy = DECISION_COPY[decision];
  return (
    <EmailLayout
      preview={`${deciderName} ${copy.verb}: ${actionSummary}`}
      reason="You got this email because your agent asked for this action."
      unsubscribeUrl={unsubscribeUrl}
    >
      <EmailHeading>
        {deciderName} {copy.verb} your agent's request
      </EmailHeading>
      <EmailParagraph>{copy.next}</EmailParagraph>
      <EmailFacts
        facts={[
          { label: "Project", value: projectName },
          { label: "Action", value: actionSummary },
        ]}
      />
      <EmailAction href={requestUrl}>Open the request</EmailAction>
    </EmailLayout>
  );
}

ApprovalDecidedEmail.PreviewProps = {
  projectName: "Analytical Engines Docs",
  actionSummary: "Publish branch agent-fix-broken-links",
  decision: "approved",
  deciderName: "Grace Hopper",
  requestUrl: "https://doxa.so/dashboard/projects/example/approvals/example",
  unsubscribeUrl: "https://doxa.so/email/unsubscribe?token=example",
} satisfies ApprovalDecidedEmailProps;

export default ApprovalDecidedEmail;
