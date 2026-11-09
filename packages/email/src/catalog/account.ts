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

/** Sent when an agent gets a token through the claim flow. It is a security notice, so nobody can turn it off. */
export const agentConnectedEmail = defineEmailKind({
  name: "agent-connected",
  category: "transactional",
  props: z.object({
    agentName: z.string().min(1).max(60),
    tokenName: z.string().min(1).max(60),
    permissions: z.array(z.string()),
    manageUrl: emailLink,
  }),
});

export type VerifyEmailEmailProps = EmailKindProps<typeof verifyEmailEmail>;
export type ResetPasswordEmailProps = EmailKindProps<typeof resetPasswordEmail>;
export type AgentConnectedEmailProps = EmailKindProps<typeof agentConnectedEmail>;
