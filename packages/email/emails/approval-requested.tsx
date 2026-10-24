import type { ApprovalRequestedEmailProps } from "../src/catalog/notifications";
import { EmailAction, EmailFacts, EmailHeading, EmailNote, EmailParagraph } from "../src/components/email-blocks";
import { EmailLayout } from "../src/components/email-layout";

export function ApprovalRequestedEmail({
  projectName,
  actionSummary,
  requesterName,
  agentName,
  reviewUrl,
  unsubscribeUrl,
}: ApprovalRequestedEmailProps) {
  return (
    <EmailLayout
      preview={`${agentName} asks to: ${actionSummary}`}
      reason="You got this email because you can approve agent actions in this project."
      unsubscribeUrl={unsubscribeUrl}
    >
      <EmailHeading>An agent action needs your approval</EmailHeading>
      <EmailParagraph>
        An agent that {requesterName} connected asks to run an action in <strong>{projectName}</strong>. Nothing runs
        until a member approves it.
      </EmailParagraph>
      <EmailFacts
        facts={[
          { label: "Action", value: actionSummary },
          { label: "Agent", value: agentName },
          { label: "Requested by", value: requesterName },
        ]}
      />
      <EmailAction href={reviewUrl}>Review the request</EmailAction>
      <EmailNote>If another member decides first, this request closes and you do not need to do anything.</EmailNote>
    </EmailLayout>
  );
}

ApprovalRequestedEmail.PreviewProps = {
  projectName: "Analytical Engines Docs",
  actionSummary: "Publish branch agent-fix-broken-links",
  requesterName: "Ada Lovelace",
  agentName: "Claude",
  reviewUrl: "https://doxa.so/dashboard/projects/example/approvals/example",
  unsubscribeUrl: "https://doxa.so/email/unsubscribe?token=example",
} satisfies ApprovalRequestedEmailProps;

export default ApprovalRequestedEmail;
