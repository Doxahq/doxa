import type { TeamRole } from "@doxahq/contracts/teams";
import { dashboardActor } from "../services/agent-access/actor";
import type { Capability } from "../services/agent-access/capabilities";
import {
  MembershipProjectAccessPolicy,
  type ProjectAccessRecord,
  type ProjectAccessStore,
} from "../services/agent-access/membership-project-access-policy";
import type { ProjectAccessPolicy } from "../services/agent-access/project-access-policy";
import { ProjectAccessRepository } from "../services/agent-access/project-access-repository";
import type { ApiContext } from "./app";
import { withUser } from "./auth";
import { requestState } from "./request-state";
import { error, notFound } from "./response";

/** What a dashboard route knows after the policy allowed the signed-in user. */
export interface DashboardProjectAccess {
  /** The signed-in user: the one who acts, for attribution. */
  readonly actorUserId: string;
  readonly projectId: string;
  /**
   * The project owner (`projects.user_id`). Owner-scoped repositories and
   * services take this ID: storage, billing and GitHub stay with the owner,
   * while the policy decides who may act.
   */
  readonly ownerUserId: string;
  readonly role: TeamRole;
  readonly capabilities: ReadonlySet<Capability>;
}

export type DashboardPolicyFactory = (context: ApiContext) => ProjectAccessPolicy;

const policyFromEnv: DashboardPolicyFactory = (context) =>
  new MembershipProjectAccessPolicy(requestAccessStore(context));

/**
 * The access store of this request. It answers each (project, user) pair
 * from one query per request. The policy still decides each capability on
 * its own, from that fresh row: nothing is kept between requests.
 */
export function requestAccessStore(context: ApiContext): ProjectAccessStore {
  const state = requestState(context.req.raw, context.env);
  state.accessStore ??= memoizeAccessStore(new ProjectAccessRepository(context.env));
  return state.accessStore;
}

export function memoizeAccessStore(store: ProjectAccessStore): ProjectAccessStore {
  const records = new Map<string, Promise<ProjectAccessRecord | null>>();

  return {
    findAccess(projectId, userId) {
      const key = JSON.stringify([projectId, userId]);
      const cached = records.get(key);
      if (cached) return cached;

      const pending = store.findAccess(projectId, userId);
      records.set(key, pending);
      pending.catch(() => {
        if (records.get(key) === pending) records.delete(key);
      });
      return pending;
    },
    listAccessibleProjects: (userId) => store.listAccessibleProjects(userId),
  };
}

/**
 * Every dashboard route under `/projects/:projectId` authorizes here (v2 spec
 * §5). A user with no role gets 404, so the route never reveals that the
 * project exists; a member whose role lacks the capability gets 403.
 */
export function withProjectAccess(
  context: ApiContext,
  capability: Capability,
  handler: (access: DashboardProjectAccess) => Promise<Response>,
  policyFor: DashboardPolicyFactory = policyFromEnv,
): Promise<Response> {
  return withUser(context, async (userId) => {
    const projectId = context.req.param("projectId");
    if (!projectId) return notFound();
    const decision = await requestState(context.req.raw, context.env).timing.measure(
      "access",
      () => policyFor(context).authorize(dashboardActor(userId), projectId, capability),
    );
    if (!decision.allowed) {
      return decision.reason === "forbidden" ? forbidden() : notFound();
    }
    const { project } = decision;
    return handler({
      actorUserId: userId,
      projectId: project.projectId,
      ownerUserId: project.ownerUserId,
      role: project.role,
      capabilities: project.capabilities,
    });
  });
}

export function forbidden(
  message = "Your role on this project does not allow this action.",
): Response {
  return error(message, 403, { code: "forbidden" });
}
