import type { PaygStartedEmailProps } from "../src/catalog/billing";
import { accountSubject, automaticChargeNote, billingReason } from "../src/components/billing-copy";
import { EmailAction, EmailHeading, EmailNote, EmailParagraph } from "../src/components/email-blocks";
import { EmailLayout } from "../src/components/email-layout";

export function PaygStartedEmail({ teamName, billingUrl, chargeAtUsd, monthlyLimitUsd, resetsOn }: PaygStartedEmailProps) {
  return (
    <EmailLayout preview="Your AI credits are used up. AI runs continue on pay-as-you-go." reason={billingReason(teamName)}>
      <EmailHeading>Pay-as-you-go started</EmailHeading>
      <EmailParagraph>
        {accountSubject(teamName)} used all its AI credits of this month. AI runs continue on pay-as-you-go at $0.01 for
        each credit.
      </EmailParagraph>
      <EmailParagraph>
        {automaticChargeNote(chargeAtUsd)} Your monthly limit is {monthlyLimitUsd}. The credits reset on {resetsOn}.
      </EmailParagraph>
      <EmailAction href={billingUrl}>Open billing</EmailAction>
      <EmailNote>You can change the monthly limit or turn pay-as-you-go off on the billing page.</EmailNote>
    </EmailLayout>
  );
}

PaygStartedEmail.PreviewProps = {
  billingUrl: "https://doxa.so/dashboard/billing/example",
  chargeAtUsd: "$5",
  monthlyLimitUsd: "$30",
  resetsOn: "December 1, 2026",
} satisfies PaygStartedEmailProps;

export default PaygStartedEmail;
