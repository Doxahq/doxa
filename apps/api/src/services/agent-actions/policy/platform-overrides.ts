import type { AgentActionKind } from "@doxahq/contracts/approval-requests";
import type {
  ApprovalMode,
  ApprovalPolicyQuery,
  ApprovalPolicySource,
  ApprovalPolicySourceName,
} from "./approval-policy";

export type PlatformOverrideTarget =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "user"; readonly userId: string };

export interface PlatformOverride {
  readonly action: AgentActionKind;
  readonly target: PlatformOverrideTarget;
  readonly mode: ApprovalMode;
}

/**
 * Operator overrides that ship with a release, for one project or one user.
 * A mode outside the action's `allowedModes` is ignored by the resolver.
 *
 * Example: { action: "docs.publish", target: { kind: "project", projectId: "<uuid>" }, mode: "allow" }
 */
export const PLATFORM_OVERRIDES: readonly PlatformOverride[] = [];

export const PLATFORM_OVERRIDE_SOURCE = "platform_override" satisfies ApprovalPolicySourceName;

/** A project entry is more specific than a user entry, so it wins. */
export class PlatformOverrideSource implements ApprovalPolicySource {
  readonly name = PLATFORM_OVERRIDE_SOURCE;

  constructor(private readonly overrides: readonly PlatformOverride[] = PLATFORM_OVERRIDES) {}

  async modeFor(query: ApprovalPolicyQuery): Promise<ApprovalMode | undefined> {
    const forAction = this.overrides.filter((entry) => entry.action === query.action);
    const projectEntry = forAction.find(
      (entry) => entry.target.kind === "project" && entry.target.projectId === query.projectId,
    );
    if (projectEntry) return projectEntry.mode;
    const userId = query.actor.principal.userId;
    return forAction.find((entry) => entry.target.kind === "user" && entry.target.userId === userId)
      ?.mode;
  }
}
