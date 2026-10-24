import type { Actor, AgentActor } from "../agent-access/actor";
import type { Capability } from "../agent-access/capabilities";
import type { ProjectAccessPolicy } from "../agent-access/project-access-policy";
import { capabilitiesForScopes } from "../agent-access/scopes";
import type { ActionRequester, ActionTarget } from "./action-definition";
import { ActionAccessDeniedError, ActionInputError } from "./errors";
import type { RegisteredAction } from "./registered-action";

export type ActionAccessPolicy = Pick<ProjectAccessPolicy, "authorize">;

/**
 * Checks the actor for one capability and returns the target the action
 * runs on. A principal action (`project.create`) has no project, so only
 * the grant scopes of an agent limit it.
 */
export async function authorizeActionTarget(
  access: ActionAccessPolicy,
  actor: Actor,
  action: Pick<RegisteredAction, "targetKind">,
  projectId: string | null,
  capability: Capability,
): Promise<ActionTarget> {
  if (action.targetKind === "principal") {
    if (projectId !== null) throw new ActionInputError("This action takes no project ID.");
    const { channel } = actor;
    if (channel.kind === "agent" && !capabilitiesForScopes(channel.scopes).has(capability)) {
      throw new ActionAccessDeniedError("scope_missing");
    }
    return { kind: "principal", userId: actor.principal.userId };
  }
  if (projectId === null) throw new ActionInputError("This action needs a project ID.");
  const decision = await access.authorize(actor, projectId, capability);
  if (!decision.allowed) throw new ActionAccessDeniedError(decision.reason);
  return {
    kind: "project",
    projectId: decision.project.projectId,
    ownerUserId: decision.project.ownerUserId,
  };
}

export function requesterOf(actor: AgentActor): ActionRequester {
  return {
    userId: actor.principal.userId,
    clientId: actor.channel.clientId,
    clientName: actor.channel.clientName,
    grantRef: actor.channel.grantRef,
  };
}

/**
 * Principal actions have no project, so their target key also names the
 * user; otherwise two users' requests would share one pending slot.
 */
export function storedTargetKey(target: ActionTarget, targetKey: string): string {
  return target.kind === "principal" ? `user:${target.userId}:${targetKey}` : targetKey;
}
