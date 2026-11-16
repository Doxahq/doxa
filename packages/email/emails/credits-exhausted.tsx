import type { CreditsExhaustedEmailProps } from "../src/catalog/billing";
import { accountSubject, billingReason } from "../src/components/billing-copy";
import { EmailAction, EmailHeading, EmailNote, EmailParagraph } from "../src/components/email-blocks";
import { EmailLayout } from "../src/components/email-layout";

export function CreditsExhaustedEmail({ teamName, billingUrl, trialCredits }: CreditsExhaustedEmailProps) {
  return (
    <EmailLayout preview="Your trial credits are used up. AI runs are stopped." reason={billingReason(teamName)}>
      <EmailHeading>Your trial credits are used up</EmailHeading>
      <EmailParagraph>
        {accountSubject(teamName)} used all its {trialCredits ? `${trialCredits} ` : ""}trial credits. AI runs stop until
        the paid plan starts.
      </EmailParagraph>
      <EmailAction href={billingUrl}>Open billing</EmailAction>
      <EmailNote>Your published docs, hosting and editing keep working.</EmailNote>
    </EmailLayout>
  );
}

CreditsExhaustedEmail.PreviewProps = {
  billingUrl: "https://doxa.so/dashboard/billing/example",
  trialCredits: 1_000,
} satisfies CreditsExhaustedEmailProps;

export default CreditsExhaustedEmail;
