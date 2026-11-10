import type { WarmPool } from "@doxahq/contracts/docs-warm-state";
import type { Env } from "../../env";
import { AgentActivityRepository } from "../../repositories/agent-activity";
import { AgentApprovalRequestsRepository } from "../../repositories/agent-approval-requests";
import { ApprovalSettingsRepository } from "../../repositories/approval-settings";
import { UserDirectoryRepository } from "../../repositories/user-directory";
import { MembershipProjectAccessPolicy } from "../agent-access/membership-project-access-policy";
import { approvalNotifierFromEnv } from "../email/notifications";
import type { Defer } from "../generation-dispatch";
import { actionServicesFromEnv } from "./action-services";
import { ApprovalService } from "./approval-service";
import { ApprovalSettingsService } from "./approval-settings-service";
import { ApprovalSweeper } from "./approval-sweeper";
import { AgentActionGateway } from "./gateway";
import { approvalPolicyFor } from "./policy/policy-sources";
import { AGENT_ACTIONS } from "./registry";
import { isAgentLiveActivityEnabled } from "@doxahq/contracts/agent-live-activity";
import { AgentLiveEventRepository } from "../../repositories/agent-live-events";

export interface AgentActionRuntime {
  readonly gateway: AgentActionGateway;
  readonly approvals: ApprovalService;
  readonly settings: ApprovalSettingsService;
  readonly sweeper: ApprovalSweeper;
  /** The dashboard origin of approval links. */
  readonly webOrigin: string;
}

export interface AgentActionRuntimeOptions {
  readonly defer: Defer;
  /** The dashboard origin for approval links; falls back to `WEB_ORIGIN`. */
  readonly webOrigin?: string;
  /**
   * The cache pool of the person whose request runs the actions (M45). Only
   * the dashboard approve route sets it; agent calls over RPC have none.
   */
  readonly warmRegion?: WarmPool | null;
}

/** The composition root of the action layer: the only place it meets the env. */
export function createAgentActionRuntime(env: Env, options: AgentActionRuntimeOptions): AgentActionRuntime {
  const registry = AGENT_ACTIONS;
  const requests = new AgentApprovalRequestsRepository(env);
  const access = MembershipProjectAccessPolicy.fromEnv(env);
  const services = actionServicesFromEnv(env, {
    defer: options.defer,
    warmRegion: options.warmRegion ?? null,
  });
  const now = () => new Date();
  const settings = new ApprovalSettingsRepository(env);
  const activity = new AgentActivityRepository(env);
  const policy = approvalPolicyFor(registry, settings, settings);
  const webOrigin = options.webOrigin ?? webOriginOf(env);
  const notifier = approvalNotifierFromEnv(env, registry, options.defer);
  return {
    gateway: new AgentActionGateway({
      registry,
      access,
      policy,
      requests,
      services,
      webOrigin,
      now,
      notifier,
    }),
    approvals: new ApprovalService({
      registry,
      requests,
      access,
      services,
      activity,
      liveEvents: isAgentLiveActivityEnabled(env.AGENT_LIVE_ACTIVITY_ENABLED)
        ? new AgentLiveEventRepository(env)
        : undefined,
      flags: settings,
      users: new UserDirectoryRepository(env),
      defer: options.defer,
      now,
      notifier,
    }),
    settings: new ApprovalSettingsService({
      registry,
      access,
      store: settings,
      policyFor: (modes) => approvalPolicyFor(registry, modes, settings),
      activity,
      now,
    }),
    sweeper: new ApprovalSweeper({ registry, requests, access, services, policy, now }),
    webOrigin,
  };
}

/** Matches `WEB_ORIGIN` in the local wrangler.json; production always sets it. */
const LOCAL_WEB_ORIGIN = "http://localhost:3001";

function webOriginOf(env: Env): string {
  return env.WEB_ORIGIN?.replace(/\/+$/, "") || LOCAL_WEB_ORIGIN;
}
