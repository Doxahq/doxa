import {
  OAUTH_SCOPE_IMPLICATIONS,
  type OAuthScope,
} from "@doxahq/contracts/agent-access";
import type { Capability } from "./capabilities";

/**
 * `approvals.decide`, `approvals.configure`, `team.manage` and `team.delete`
 * are in no list on purpose: a human decides approval requests, sets their
 * gates and runs the team, so no OAuth scope can ever grant them to an agent.
 */
export const SCOPE_CAPABILITIES = {
  "projects:read": ["project.read", "domains.read", "generation.read"],
  "projects:write": ["project.create", "project.delete"],
  "docs:read": ["docs.read"],
  "docs:write": ["docs.write"],
  "site:write": ["site.write"],
  "domains:write": ["domains.write"],
  publish: ["docs.publish", "docs.restore"],
  "generation:run": ["generation.run"],
} as const satisfies Record<OAuthScope, readonly Capability[]>;

export function expandScopes(
  granted: Iterable<OAuthScope>,
): ReadonlySet<OAuthScope> {
  const expanded = new Set<OAuthScope>();
  const pending = [...granted];
  for (let scope = pending.pop(); scope !== undefined; scope = pending.pop()) {
    if (expanded.has(scope)) continue;
    expanded.add(scope);
    pending.push(...OAUTH_SCOPE_IMPLICATIONS[scope]);
  }
  return expanded;
}

/** Callers pass expanded scopes; implied scopes are not added here. */
export function capabilitiesForScopes(
  scopes: Iterable<OAuthScope>,
): ReadonlySet<Capability> {
  const capabilities = new Set<Capability>();
  for (const scope of scopes) {
    for (const capability of SCOPE_CAPABILITIES[scope]) {
      capabilities.add(capability);
    }
  }
  return capabilities;
}
