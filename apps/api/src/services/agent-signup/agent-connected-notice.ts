import { agentConnectedEmail } from "@doxahq/email/catalog";
import type { Env } from "../../env";
import { AccountEmailRepository } from "../../repositories/agent-claims";
import { EmailOutbox } from "../email/email-outbox";

export interface AgentConnectedEvent {
  readonly registrationId: string;
  readonly userId: string;
  readonly agentName: string;
  readonly tokenName: string;
  readonly scopes: readonly string[];
}

/** Tells a person that an agent got access, so that a tricked person can act. */
export type AgentConnectedNotifier = (event: AgentConnectedEvent) => Promise<void>;

export function createAgentConnectedNotifier(env: Env): AgentConnectedNotifier {
  return async (event) => {
    const email = await new AccountEmailRepository(env).findEmail(event.userId);
    if (email === null) return;
    const outbox = EmailOutbox.fromEnv(env);
    await outbox.enqueue(
      agentConnectedEmail,
      {
        agentName: event.agentName,
        tokenName: event.tokenName,
        permissions: [...event.scopes],
        manageUrl: `${outbox.links.webOrigin}/dashboard/settings/agents`,
      },
      { email, userId: event.userId },
      `agent-connected:${event.registrationId}`,
    );
  };
}
