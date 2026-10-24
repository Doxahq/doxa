import type { DocsContentEditOrigin } from "@doxahq/contracts";
import {
  isOAuthScope,
  type OAuthScope,
  type ProjectScopeClaim,
} from "@doxahq/contracts/agent-access";
import { expandScopes } from "./scopes";

export type UserId = string & { readonly __brand: "UserId" };
export type ProjectId = string & { readonly __brand: "ProjectId" };

// The only casts to the branded types. Every other module gets a UserId or a
// ProjectId from these helpers, so a raw string never passes as an ID silently.
export function toUserId(value: string): UserId {
  return value as UserId;
}

export function toProjectId(value: string): ProjectId {
  return value as ProjectId;
}

export interface Principal {
  readonly kind: "user";
  readonly userId: UserId;
}

export interface DashboardChannel {
  readonly kind: "dashboard";
}

export interface AgentChannel {
  readonly kind: "agent";
  readonly clientId: string;
  readonly clientName: string;
  readonly grantRef: string;
  /** Expanded with implied scopes. */
  readonly scopes: ReadonlySet<OAuthScope>;
  readonly projectScope: ProjectScope;
}

export type Channel = DashboardChannel | AgentChannel;

export type ProjectScope =
  | { readonly kind: "all" }
  | { readonly kind: "selected"; readonly projectIds: ReadonlySet<ProjectId> };

export interface Actor {
  readonly principal: Principal;
  readonly channel: Channel;
}

export type DashboardActor = Actor & { readonly channel: DashboardChannel };
export type AgentActor = Actor & { readonly channel: AgentChannel };

export interface AgentActorClaims {
  userId: string;
  clientId: string;
  clientName: string;
  grantRef: string;
  /** Raw token scopes. Unknown strings are dropped, never trusted. */
  scopes: readonly string[];
  projectScope: ProjectScopeClaim;
}

export function dashboardActor(userId: string): DashboardActor {
  return {
    principal: userPrincipal(userId),
    channel: { kind: "dashboard" },
  };
}

export function agentActor(claims: AgentActorClaims): AgentActor {
  return {
    principal: userPrincipal(claims.userId),
    channel: {
      kind: "agent",
      clientId: claims.clientId,
      clientName: claims.clientName,
      grantRef: claims.grantRef,
      scopes: expandScopes(claims.scopes.filter(isOAuthScope)),
      projectScope: projectScopeFromClaim(claims.projectScope),
    },
  };
}

export function editOriginFor(actor: Actor): DocsContentEditOrigin {
  return actor.channel.kind === "agent" ? "mcp" : "editor";
}

function userPrincipal(userId: string): Principal {
  return { kind: "user", userId: toUserId(userId) };
}

function projectScopeFromClaim(claim: ProjectScopeClaim): ProjectScope {
  if (claim.kind === "all") return { kind: "all" };
  return {
    kind: "selected",
    projectIds: new Set(claim.projectIds.map(toProjectId)),
  };
}
