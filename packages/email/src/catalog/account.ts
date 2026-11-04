import { z } from "zod";
import { defineEmailKind, type EmailKindProps } from "./define-email-kind";
import { emailLink } from "./fields";

/** Sent after an email and password sign-up, and again when an unverified account tries to sign in. */
export const verifyEmailEmail = defineEmailKind({
  name: "verify-email",
  category: "transactional",
  props: z.object({
    verifyUrl: emailLink,
    expiresInHours: z.number().int().positive(),
  }),
});

/** Sent when someone asks to reset the password of an email and password account. */
export const resetPasswordEmail = defineEmailKind({
  name: "reset-password",
  category: "transactional",
  props: z.object({
    resetUrl: emailLink,
    expiresInMinutes: z.number().int().positive(),
  }),
});

export type VerifyEmailEmailProps = EmailKindProps<typeof verifyEmailEmail>;
export type ResetPasswordEmailProps = EmailKindProps<typeof resetPasswordEmail>;
