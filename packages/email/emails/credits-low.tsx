import type { CreditsLowEmailProps } from "../src/catalog/billing";
import { accountSubject, billingReason } from "../src/components/billing-copy";
import { EmailAction, EmailHeading, EmailParagraph } from "../src/components/email-blocks";
import { EmailLayout } from "../src/components/email-layout";

export function CreditsLowEmail({ teamName, billingUrl, usedCredits, allowanceCredits, resetsOn, paygOn }: CreditsLowEmailProps) {
  return (
    <EmailLayout preview={`${usedCredits} of ${allowanceCredits} AI credits used this month.`} reason={billingReason(teamName)}>
      <EmailHeading>80% of your AI credits are used</EmailHeading>
      <EmailParagraph>
        {accountSubject(teamName)} used {usedCredits} of its {allowanceCredits} AI credits this month. The credits reset on{" "}
        {resetsOn}.
      </EmailParagraph>
      <EmailParagraph>
        {paygOn
          ? "When the credits run out, AI runs continue on pay-as-you-go at $0.01 for each credit."
          : "When the credits run out, AI runs stop until the credits reset."}
      </EmailParagraph>
      <EmailAction href={billingUrl}>Open billing</EmailAction>
    </EmailLayout>
  );
}

CreditsLowEmail.PreviewProps = {
  billingUrl: "https://doxa.so/dashboard/billing/example",
  usedCredits: 4_000,
  allowanceCredits: 5_000,
  resetsOn: "December 1, 2026",
  paygOn: true,
} satisfies CreditsLowEmailProps;

export default CreditsLowEmail;
