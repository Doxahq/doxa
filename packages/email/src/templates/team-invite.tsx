import { TeamInviteEmail } from "../../emails/team-invite";
import { teamInviteEmail } from "../catalog/team-invite";
import { defineEmailTemplate } from "./define-email-template";

export const teamInviteTemplate = defineEmailTemplate(teamInviteEmail, {
  subject: ({ inviterName, teamName }) => `${inviterName} invited you to ${teamName} on Doxa`,
  render: (props) => <TeamInviteEmail {...props} />,
});
