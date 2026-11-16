import { CreditsExhaustedEmail } from "../../emails/credits-exhausted";
import { CreditsLowEmail } from "../../emails/credits-low";
import { PaygLimitEmail } from "../../emails/payg-limit";
import { PaygStartedEmail } from "../../emails/payg-started";
import { creditsExhaustedEmail, creditsLowEmail, paygLimitEmail, paygStartedEmail } from "../catalog/billing";
import { defineEmailTemplate } from "./define-email-template";

const forTeam = (teamName: string | undefined) => (teamName ? ` for ${teamName}` : "");

export const creditsLowTemplate = defineEmailTemplate(creditsLowEmail, {
  subject: ({ teamName }) => `80% of your AI credits are used${forTeam(teamName)}`,
  render: (props) => <CreditsLowEmail {...props} />,
});

export const paygStartedTemplate = defineEmailTemplate(paygStartedEmail, {
  subject: ({ teamName }) => `Pay-as-you-go started${forTeam(teamName)}`,
  render: (props) => <PaygStartedEmail {...props} />,
});

export const paygLimitTemplate = defineEmailTemplate(paygLimitEmail, {
  subject: ({ teamName, percent }) =>
    percent === 100
      ? `You reached your pay-as-you-go limit${forTeam(teamName)}`
      : `${percent}% of your pay-as-you-go limit is used${forTeam(teamName)}`,
  render: (props) => <PaygLimitEmail {...props} />,
});

export const creditsExhaustedTemplate = defineEmailTemplate(creditsExhaustedEmail, {
  subject: ({ teamName }) => `Your trial credits are used up${forTeam(teamName)}`,
  render: (props) => <CreditsExhaustedEmail {...props} />,
});
