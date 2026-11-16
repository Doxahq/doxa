import type { PaygLimitEmailProps } from "../src/catalog/billing";
import { accountSubject, automaticChargeNote, billingReason } from "../src/components/billing-copy";
import { EmailAction, EmailHeading, EmailNote, EmailParagraph } from "../src/components/email-blocks";
import { EmailLayout } from "../src/components/email-layout";

export function PaygLimitEmail({ teamName, billingUrl, percent, spentUsd, monthlyLimitUsd, chargeAtUsd, resetsOn }: PaygLimitEmailProps) {
  const reached = percent === 100;
  return (
    <EmailLayout
      preview={`${spentUsd} of the ${monthlyLimitUsd} monthly pay-as-you-go limit is used.`}
      reason={billingReason(teamName)}
    >
      <EmailHeading>{reached ? "You reached your pay-as-you-go limit" : `${percent}% of your pay-as-you-go limit is used`}</EmailHeading>
      <EmailParagraph>
        {accountSubject(teamName)} used {spentUsd} of its {monthlyLimitUsd} monthly pay-as-you-go limit.
      </EmailParagraph>
      <EmailParagraph>
        {reached
          ? `AI runs stop until ${resetsOn}, or until you raise the limit.`
          : `At the limit, AI runs stop until ${resetsOn}.`}
      </EmailParagraph>
      <EmailAction href={billingUrl}>{reached ? "Raise the limit" : "Open billing"}</EmailAction>
      <EmailNote>{automaticChargeNote(chargeAtUsd)}</EmailNote>
    </EmailLayout>
  );
}

PaygLimitEmail.PreviewProps = {
  billingUrl: "https://doxa.so/dashboard/billing/example",
  percent: 80,
  spentUsd: "$24",
  monthlyLimitUsd: "$30",
  chargeAtUsd: "$5",
  resetsOn: "December 1, 2026",
} satisfies PaygLimitEmailProps;

export default PaygLimitEmail;
