import {
  EMAIL_VERIFICATION_EXPIRES_IN_SECONDS,
  RESET_PASSWORD_EXPIRES_IN_SECONDS,
  type AuthEmail,
  type AuthMailer,
} from "@doxahq/auth";
import { resetPasswordEmail, verifyEmailEmail } from "@doxahq/email/catalog";
import type { Env } from "../../env";
import { EmailOutbox } from "../email/email-outbox";

/**
 * Queues the account emails of email and password sign-in (`verify-email`,
 * `reset-password`) in the email outbox. Each link is queued once: the dedupe
 * key is a hash of the link, so the token itself never lands in the key.
 */
export class OutboxAuthMailer implements AuthMailer {
  constructor(private readonly outbox: () => Pick<EmailOutbox, "enqueue">) {}

  /** The outbox is built on first use, so an auth request that sends no email opens no extra pool. */
  static fromEnv(env: Env): OutboxAuthMailer {
    let outbox: EmailOutbox | null = null;
    return new OutboxAuthMailer(() => (outbox ??= EmailOutbox.fromEnv(env)));
  }

  async sendVerificationEmail(email: AuthEmail): Promise<void> {
    await this.outbox().enqueue(
      verifyEmailEmail,
      { verifyUrl: email.url, expiresInHours: EMAIL_VERIFICATION_EXPIRES_IN_SECONDS / 3600 },
      { email: email.email, userId: email.userId },
      `verify-email:${await linkHash(email.url)}`,
    );
  }

  async sendResetPasswordEmail(email: AuthEmail): Promise<void> {
    await this.outbox().enqueue(
      resetPasswordEmail,
      { resetUrl: email.url, expiresInMinutes: RESET_PASSWORD_EXPIRES_IN_SECONDS / 60 },
      { email: email.email, userId: email.userId },
      `reset-password:${await linkHash(email.url)}`,
    );
  }
}

async function linkHash(url: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
