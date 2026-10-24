import type { EmailAddress } from "./address";
import { streamOf, type EmailKind, type EmailKindProps } from "./catalog/define-email-kind";
import { readSenders, type EmailEnv, type EmailSenders } from "./config";
import { findEmailMessageProblem, type EmailMessage } from "./message";
import { createEmailTransport } from "./provider-registry";
import { emailFailed, type SendEmailResult } from "./send-result";
import { renderEmailTemplate, type EmailTemplate } from "./templates/define-email-template";
import type { EmailTransport } from "./transport";

/** Who gets one email, and the keys that tie it to a Doxa record. */
export interface EmailEnvelope {
  readonly to: EmailAddress | readonly EmailAddress[];
  /** A stable key, such as the outbox delivery ID. */
  readonly idempotencyKey?: string;
  /** Extra headers, such as `List-Unsubscribe` for notification emails. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface MailerDeps {
  readonly transport: EmailTransport;
  /** One sender for each stream; the kind's category picks the stream. */
  readonly senders: EmailSenders;
}

export const TEMPLATE_HEADER = "X-Doxa-Template";

/**
 * Renders a template and sends it. The mailer depends on `EmailTransport`
 * only, so it works the same with every provider. It loads React, so only the
 * Worker that delivers email imports it.
 */
export class Mailer {
  constructor(private readonly deps: MailerDeps) {}

  /** Reads `EMAIL_PROVIDER`, the stream senders and the provider settings. Throws `EmailConfigurationError`. */
  static fromEnv(env: EmailEnv): Mailer {
    return new Mailer({ transport: createEmailTransport(env), senders: readSenders(env) });
  }

  get provider(): string {
    return this.deps.transport.provider;
  }

  /** Sends one email with props that the compiler checked. */
  send<Kind extends EmailKind>(
    template: EmailTemplate<Kind>,
    props: EmailKindProps<Kind>,
    envelope: EmailEnvelope,
  ): Promise<SendEmailResult> {
    return this.sendStored(template, props, envelope);
  }

  /**
   * Sends one email with props read from storage, such as an outbox row.
   * Props that do not match the kind's schema give an `invalid_message` failure.
   */
  async sendStored(template: EmailTemplate, props: unknown, envelope: EmailEnvelope): Promise<SendEmailResult> {
    const parsed = template.kind.props.safeParse(props);
    if (!parsed.success) {
      return emailFailed(this.provider, "invalid_message", `Props for "${template.kind.name}" are not valid.`);
    }
    const rendered = await renderEmailTemplate(template, parsed.data);
    const sender = this.deps.senders[streamOf(template.kind.category)];
    const message: EmailMessage = {
      from: sender.from,
      ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
      to: toList(envelope.to),
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      headers: { ...envelope.headers, [TEMPLATE_HEADER]: template.kind.name },
      ...(envelope.idempotencyKey ? { idempotencyKey: envelope.idempotencyKey } : {}),
    };
    const problem = findEmailMessageProblem(message);
    if (problem) return emailFailed(this.provider, "invalid_message", problem);
    return this.deps.transport.send(message);
  }
}

function toList(to: EmailAddress | readonly EmailAddress[]): readonly EmailAddress[] {
  return isAddressList(to) ? to : [to];
}

function isAddressList(to: EmailAddress | readonly EmailAddress[]): to is readonly EmailAddress[] {
  return Array.isArray(to);
}
