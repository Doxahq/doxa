import { ResetPasswordEmail } from "../../emails/reset-password";
import { VerifyEmailEmail } from "../../emails/verify-email";
import { resetPasswordEmail, verifyEmailEmail } from "../catalog/account";
import { defineEmailTemplate } from "./define-email-template";

export const verifyEmailTemplate = defineEmailTemplate(verifyEmailEmail, {
  subject: () => "Verify your email for Doxa",
  render: (props) => <VerifyEmailEmail {...props} />,
});

export const resetPasswordTemplate = defineEmailTemplate(resetPasswordEmail, {
  subject: () => "Reset your Doxa password",
  render: (props) => <ResetPasswordEmail {...props} />,
});
