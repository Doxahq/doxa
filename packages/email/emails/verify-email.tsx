import type { VerifyEmailEmailProps } from "../src/catalog/account";
import { EmailAction, EmailHeading, EmailNote, EmailParagraph } from "../src/components/email-blocks";
import { EmailLayout } from "../src/components/email-layout";

export function VerifyEmailEmail({ verifyUrl, expiresInHours }: VerifyEmailEmailProps) {
  return (
    <EmailLayout
      preview="Confirm your email address to finish creating your Doxa account."
      reason="You got this email because someone created a Doxa account with this address."
    >
      <EmailHeading>Verify your email</EmailHeading>
      <EmailParagraph>Confirm this address to finish creating your Doxa account.</EmailParagraph>
      <EmailAction href={verifyUrl}>Verify email</EmailAction>
      <EmailNote>
        The link expires in {expiresInHours} {expiresInHours === 1 ? "hour" : "hours"}. If you did not create a Doxa
        account, you can ignore this email.
      </EmailNote>
    </EmailLayout>
  );
}

VerifyEmailEmail.PreviewProps = {
  verifyUrl: "https://api.doxa.so/api/auth/verify-email?token=example-token",
  expiresInHours: 24,
} satisfies VerifyEmailEmailProps;

export default VerifyEmailEmail;
