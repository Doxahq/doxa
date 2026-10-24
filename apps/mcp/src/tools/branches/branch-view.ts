import {
  docsBranchSchema,
  type DocsBranchCreator,
  type NamedDocsBranch,
} from "@doxahq/contracts/docs-branches";
import { z } from "zod";
import type { BranchAgentIdentity } from "@doxahq/api/repositories/docs-branch-management";
import { isCreatedByAgent } from "@doxahq/api/repositories/docs-branch-records";
import type { AgentActor } from "@doxahq/api/services/agent-access/actor";

/**
 * The creator as an agent sees it. The OAuth client ID stays out; `isCaller`
 * tells the agent whether delete_branch can remove the branch.
 */
const agentBranchCreatorOutput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }).strict(),
  z
    .object({
      kind: z.literal("agent"),
      clientName: z.string(),
      isCaller: z
        .boolean()
        .describe(
          "True when this connection's client created the branch for the same user.",
        ),
    })
    .strict(),
]);

export const agentBranchOutput = docsBranchSchema.options[0]
  .extend({ createdBy: agentBranchCreatorOutput })
  .strict();

export type AgentBranchView = z.infer<typeof agentBranchOutput>;

export function toAgentBranchView(
  branch: NamedDocsBranch,
  actor: AgentActor,
): AgentBranchView {
  return { ...branch, createdBy: creatorView(branch.createdBy, actor) };
}

function creatorView(
  creator: DocsBranchCreator,
  actor: AgentActor,
): AgentBranchView["createdBy"] {
  if (creator.kind === "user") return creator;
  return {
    kind: "agent",
    clientName: creator.clientName,
    isCaller: isCreatedByAgent(creator, agentIdentity(actor)),
  };
}

/**
 * The agent as its branches record it. The user is the member behind the
 * connection, never the project owner the branch row belongs to.
 */
export function agentIdentity(actor: AgentActor): BranchAgentIdentity {
  return { clientId: actor.channel.clientId, userId: actor.principal.userId };
}

/** The creator columns of a branch that this agent creates. */
export function agentCreator(actor: AgentActor): DocsBranchCreator {
  return {
    kind: "agent",
    clientName: actor.channel.clientName,
    ...agentIdentity(actor),
  };
}
