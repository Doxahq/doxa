import type { TeamInviteEmailProps, TeamInviteRole } from "../src/catalog/team-invite";
import { EmailAction, EmailHeading, EmailNote, EmailParagraph } from "../src/components/email-blocks";
import { EmailLayout } from "../src/components/email-layout";

const ROLE_PHRASES: Readonly<Record<TeamInviteRole, string>> = {
  owner: "an owner",
  admin: "an admin",
  editor: "an editor",
  viewer: "a viewer",
};

export function TeamInviteEmail({ inviterName, teamName, role, acceptUrl, expiresInDays }: TeamInviteEmailProps) {
  return (
    <EmailLayout
      preview={`${inviterName} invited you to join ${teamName} on Doxa.`}
      reason="You got this email because a Doxa team member invited this address."
    >
      <EmailHeading>Join {teamName} on Doxa</EmailHeading>
      <EmailParagraph>
        {inviterName} invited you to join the team <strong>{teamName}</strong> as {ROLE_PHRASES[role]}.
      </EmailParagraph>
      <EmailAction href={acceptUrl}>Accept invite</EmailAction>
      <EmailNote>
        The invite works once and expires in {expiresInDays} days. If you did not expect it, you can ignore this
        email.
      </EmailNote>
    </EmailLayout>
  );
}

TeamInviteEmail.PreviewProps = {
  inviterName: "Ada Lovelace",
  teamName: "Analytical Engines",
  role: "editor",
  acceptUrl: "https://doxa.so/invite/example-token",
  expiresInDays: 7,
} satisfies TeamInviteEmailProps;

export default TeamInviteEmail;
