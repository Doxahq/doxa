import type { AgentConnectedEmailProps } from "../src/catalog/account";
import { EmailAction, EmailHeading, EmailNote, EmailParagraph } from "../src/components/email-blocks";
import { EmailLayout } from "../src/components/email-layout";

export function AgentConnectedEmail({ agentName, tokenName, permissions, manageUrl }: AgentConnectedEmailProps) {
  return (
    <EmailLayout
      preview={`${agentName} now has access to your Doxa account.`}
      reason="You got this email because an agent connected to your Doxa account."
    >
      <EmailHeading>A new agent connected</EmailHeading>
      <EmailParagraph>
        An agent that calls itself {agentName} now has access to your Doxa account, with the token {tokenName}. Doxa
        cannot verify this name.
      </EmailParagraph>
      <EmailParagraph>Permissions: {permissions.join(", ")}.</EmailParagraph>
      <EmailAction href={manageUrl}>Review connected agents</EmailAction>
      <EmailNote>If you did not approve this, revoke the agent now. Access stops at once.</EmailNote>
    </EmailLayout>
  );
}

AgentConnectedEmail.PreviewProps = {
  agentName: "Claude Code",
  tokenName: "Acme docs (local)",
  permissions: ["docs:read", "docs:write"],
  manageUrl: "https://doxa.so/dashboard/settings",
} satisfies AgentConnectedEmailProps;

export default AgentConnectedEmail;
