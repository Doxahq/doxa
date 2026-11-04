import type { ResetPasswordEmailProps } from "../src/catalog/account";
import { EmailAction, EmailHeading, EmailNote, EmailParagraph } from "../src/components/email-blocks";
import { EmailLayout } from "../src/components/email-layout";

export function ResetPasswordEmail({ resetUrl, expiresInMinutes }: ResetPasswordEmailProps) {
  return (
    <EmailLayout
      preview="Choose a new password for your Doxa account."
      reason="You got this email because someone asked to reset the password of the Doxa account with this address."
    >
      <EmailHeading>Reset your password</EmailHeading>
      <EmailParagraph>Use the button below to choose a new password for your Doxa account.</EmailParagraph>
      <EmailAction href={resetUrl}>Reset password</EmailAction>
      <EmailNote>
        The link works once and expires in {expiresInMinutes} minutes. If you did not ask for a reset, you can ignore
        this email. Your password does not change.
      </EmailNote>
    </EmailLayout>
  );
}

ResetPasswordEmail.PreviewProps = {
  resetUrl: "https://api.doxa.so/api/auth/reset-password/example-token?callbackURL=https%3A%2F%2Fdoxa.so%2Freset-password",
  expiresInMinutes: 60,
} satisfies ResetPasswordEmailProps;

export default ResetPasswordEmail;
