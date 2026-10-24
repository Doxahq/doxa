import type { TeamInviteEmail, TeamInviteMailer } from "../../src/services/teams/invite-mailer";

export class RecordingInviteMailer implements TeamInviteMailer {
  readonly sent: TeamInviteEmail[] = [];

  async send(invite: TeamInviteEmail): Promise<void> {
    this.sent.push(invite);
  }
}
