import { teamInviteEmail, type TeamInviteEmailProps } from "@doxahq/email/catalog";
import type { Env } from "../../env";
import { EmailOutbox } from "../email/email-outbox";

export interface TeamInviteEmail {
  readonly inviteId: string;
  readonly email: string;
  readonly props: TeamInviteEmailProps;
}

/** Sends an invite link by email. The team service does not know about the outbox. */
export interface TeamInviteMailer {
  send(invite: TeamInviteEmail): Promise<void>;
}

/** Queues the `team-invite` email. One email for each invite, even when the request repeats. */
export class OutboxTeamInviteMailer implements TeamInviteMailer {
  constructor(private readonly outbox: () => Pick<EmailOutbox, "enqueue">) {}

  /** The outbox is built on first use, so a team request without an email opens no extra pool. */
  static fromEnv(env: Env): OutboxTeamInviteMailer {
    let outbox: EmailOutbox | null = null;
    return new OutboxTeamInviteMailer(() => (outbox ??= EmailOutbox.fromEnv(env)));
  }

  async send(invite: TeamInviteEmail): Promise<void> {
    await this.outbox().enqueue(
      teamInviteEmail,
      invite.props,
      { email: invite.email, userId: null },
      `team-invite:${invite.inviteId}`,
    );
  }
}
