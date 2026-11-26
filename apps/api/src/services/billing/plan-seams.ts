import {
  FREE_TEAMS_PER_OWNER_KEY,
  PlanLimitError,
  UNLIMITED_NUMBER,
  createEntitlementAdapters,
  isUnlimited,
  toCustomDomainLimit,
  withinLimit,
  type AccountBillingView,
  type BillingEnforcement,
} from "@doxahq/billing";
import type { PlanSearchPolicy, PlanStorageLimits, ProjectEntitlements } from "@doxahq/contracts/entitlements";
import type { Env } from "../../env";
import { createDocsDomainLimitPolicy, type DocsDomainLimitPolicy } from "../docs-domain-limit-policy";
import { createSearchPolicyService, type SearchPolicyService } from "../docs-search/policy";
import type { EntitlementsService, StorageLimitsService } from "../entitlements";
import { createEntitlements, freePlanStorageLimits } from "../free-plan-entitlements";
import { billingConfigFor } from "./config";
import { billingCoreFromEnv, type BillingCore } from "./core";
import { defaultBillingDenialLogger, type BillingDenial, type BillingDenialLogger } from "./enforcement";

/**
 * Team seats (billing spec 9.3, `team.seats`): checked at invite create and
 * accept. `used` counts members, plus pending invites at create.
 */
export interface TeamSeatPolicy {
  /** False with `BILLING_ENFORCEMENT=off`: the caller skips the counts, as before billing. */
  readonly active: boolean;
  assertSeatAvailable(input: { teamId: string; used: number }): Promise<void>;
}

/**
 * Projects per billing account (`account.projects`, decided 2026-11-23):
 * checked before a project is created. The owner is the new project's: its
 * team, else the user (billing spec 8.1).
 */
export interface ProjectLimitPolicy {
  /** False with `BILLING_ENFORCEMENT=off`: no count, as before billing. */
  readonly active: boolean;
  assertProjectAvailable(owner: { userId: string; teamId: string | null }): Promise<void>;
}

/**
 * Team creation (decided 2026-11-26): every team is a billing account with its
 * own Free allowance, so one user can own only `teams.freeTeamsPerOwner` teams
 * on Free. Past it, a create gets HTTP 403 `plan_limit` with
 * `FREE_TEAMS_PER_OWNER_KEY` and the account of the user's oldest Free team,
 * which the dashboard offers to upgrade. A paying customer has no such limit:
 * a user who owns a paid team or has a paid personal account (`isPayingCustomer`).
 */
export interface TeamCreationPolicy {
  /** False with `BILLING_ENFORCEMENT=off`: the caller skips the team list, as before billing. */
  readonly active: boolean;
  /** `ownedTeamIds`: the teams that the user owns now, oldest first. */
  assertTeamCreationAllowed(input: { userId: string; ownedTeamIds: readonly string[] }): Promise<void>;
}

/** Every plan limit check of the API (billing spec 9.3), behind its existing interface. */
export interface PlanSeams {
  readonly mode: BillingEnforcement;
  readonly entitlements: EntitlementsService & Required<Pick<EntitlementsService, "getSearchPolicy">>;
  readonly storageLimits: StorageLimitsService;
  readonly searchPolicy: SearchPolicyService;
  readonly docsDomainLimit: DocsDomainLimitPolicy;
  readonly teamSeats: TeamSeatPolicy;
  readonly projectLimit: ProjectLimitPolicy;
  readonly teamCreation: TeamCreationPolicy;
}

/** Today's free-plan stubs: the exact behavior of `BILLING_ENFORCEMENT=off`. */
export interface LegacySeams {
  readonly entitlements: EntitlementsService;
  readonly storageLimits: StorageLimitsService;
  readonly searchPolicy: SearchPolicyService;
  readonly docsDomainLimit: DocsDomainLimitPolicy;
}

export interface PlanSeamDeps {
  readonly mode: BillingEnforcement;
  readonly legacy: LegacySeams;
  /** Built only when the mode is not `off`. */
  readonly billing: () => BillingCore;
  readonly log?: BillingDenialLogger;
}

export function legacySeamsFromEnv(env: Env): LegacySeams {
  const entitlements = createEntitlements(env);
  return {
    entitlements,
    storageLimits: freePlanStorageLimits,
    searchPolicy: createSearchPolicyService(env),
    docsDomainLimit: createDocsDomainLimitPolicy(),
  };
}

/**
 * True for an account that pays today: a plan other than Free from a
 * subscription that is not a trial, or from an override (an Enterprise
 * contract). A past-due subscription still counts. A trial has not paid yet.
 */
function isPayingCustomer(view: AccountBillingView): boolean {
  return view.entitlements.plan !== "free" && view.entitlements.subscriptionStatus !== "trialing";
}

/** The seams of one env (billing spec 9.3 and 6.3 `BILLING_ENFORCEMENT`). */
export function planSeamsFromEnv(env: Env): PlanSeams {
  const { enforcement } = billingConfigFor(env);
  return createPlanSeams({ mode: enforcement, legacy: legacySeamsFromEnv(env), billing: () => billingCoreFromEnv(env) });
}

/**
 * The enforcement modes:
 *
 * - `off`: the legacy stubs answer, exactly as before billing. Billing is
 *   never built, so nothing reads the billing tables.
 * - `shadow`: the legacy value is returned (the action is allowed as today).
 *   Billing computes its value too; a stricter value or a refused check is
 *   logged as `billing.denial` with `mode: "shadow"`. A billing error is
 *   logged and never fails the request.
 * - `on`: the billing value answers, and a refused check throws
 *   `PlanLimitError` (HTTP 403 `plan_limit`).
 *
 * One seam set memoizes the account view of each project, so one request
 * reads the billing account once (billing spec 9.2).
 */
export function createPlanSeams(deps: PlanSeamDeps): PlanSeams {
  const { mode, legacy } = deps;
  const log = deps.log ?? defaultBillingDenialLogger;
  if (mode === "off") {
    return {
      mode,
      entitlements: {
        getProjectEntitlements: (projectId) => legacy.entitlements.getProjectEntitlements(projectId),
        getSearchPolicy: (projectId) => legacyEntitlementsSearch(legacy, projectId),
      },
      storageLimits: legacy.storageLimits,
      searchPolicy: legacy.searchPolicy,
      docsDomainLimit: legacy.docsDomainLimit,
      teamSeats: { active: false, assertSeatAvailable: async () => undefined },
      projectLimit: { active: false, assertProjectAvailable: async () => undefined },
      teamCreation: { active: false, assertTeamCreationAllowed: async () => undefined },
    };
  }

  let core: BillingCore | null = null;
  const billing = () => (core ??= deps.billing());
  const views = new Map<string, Promise<AccountBillingView>>();
  const viewOf = (projectId: string): Promise<AccountBillingView> => {
    let view = views.get(projectId);
    if (!view) {
      view = billing().entitlements.forProject(projectId);
      views.set(projectId, view);
      view.catch(() => views.delete(projectId));
    }
    return view;
  };
  // The package's mappings (`BillingEntitlements.adapters()`), over the memoized view.
  const adapters = createEntitlementAdapters(async (projectId) => (await viewOf(projectId)).entitlements);
  const planOf = async (projectId: string) => (await viewOf(projectId)).entitlements.plan;

  /** Returns the value for the mode and logs shadow divergences. */
  async function choose<T>(input: {
    projectId: string;
    legacy: () => Promise<T>;
    billing: () => Promise<T>;
    /** The `stricter_limit` lines for a billing value stricter than the legacy one. */
    compare: (billingValue: T, legacyValue: T) => Omit<BillingDenial, "mode" | "plan" | "kind" | "projectId">[];
  }): Promise<T> {
    if (mode === "on") return input.billing();
    const [legacyResult, billingResult] = await Promise.allSettled([input.legacy(), input.billing()]);
    if (legacyResult.status === "rejected") throw legacyResult.reason;
    if (billingResult.status === "rejected") {
      logShadowFailure(input.projectId, billingResult.reason);
      return legacyResult.value;
    }
    const lines = input.compare(billingResult.value, legacyResult.value);
    if (lines.length > 0) {
      const plan = await planOf(input.projectId).catch(() => null);
      for (const line of lines) log({ ...line, mode: "shadow", kind: "stricter_limit", plan, projectId: input.projectId });
    }
    return legacyResult.value;
  }

  const getSearchPolicy = (projectId: string) =>
    choose<PlanSearchPolicy>({
      projectId,
      legacy: () => legacy.searchPolicy.getSearchPolicy(projectId),
      billing: () => adapters.searchPolicy.getSearchPolicy(projectId),
      compare: (planValue, current) =>
        current.allowedProviders.includes("typesense") && !planValue.allowedProviders.includes("typesense")
          ? [{ key: "site.typesense_search", limit: false, current: true }]
          : [],
    });

  const getProjectEntitlements = (projectId: string) =>
    choose<ProjectEntitlements>({
      projectId,
      legacy: () => legacy.entitlements.getProjectEntitlements(projectId),
      billing: () => adapters.entitlements.getProjectEntitlements(projectId),
      compare: (planValue, current) => [
        ...(planValue.maxBranchesPerSite < current.maxBranchesPerSite
          ? [{ key: "docs.branches_per_site", limit: planValue.maxBranchesPerSite, current: current.maxBranchesPerSite }]
          : []),
        ...(current.removePoweredBy && !planValue.removePoweredBy
          ? [{ key: "site.remove_powered_by", limit: false, current: true }]
          : []),
      ],
    });

  const getStorageLimits = (projectId: string) =>
    choose<PlanStorageLimits>({
      projectId,
      legacy: () => legacy.storageLimits.getStorageLimits(projectId),
      billing: () => adapters.storageLimits.getStorageLimits(projectId),
      compare: (planValue, current) =>
        (
          [
            ["docs.storage_bytes", planValue.maxDocsStorageBytes, current.maxDocsStorageBytes],
            ["site.asset_bytes", planValue.maxSiteAssetBytes, current.maxSiteAssetBytes],
            ["site.asset_files", planValue.maxSiteAssetFiles, current.maxSiteAssetFiles],
          ] as const
        )
          .filter(([, planLimit, currentLimit]) => planLimit < currentLimit)
          .map(([key, planLimit, currentLimit]) => ({ key, limit: planLimit, current: currentLimit })),
    });

  /**
   * Decision D9: the custom domain limit is for each account. The legacy
   * policy and the domains repository count the domains of one project, so
   * the seam answers the project's share: the account limit minus the custom
   * domains on the account's other projects. Two projects that add a domain
   * at the same moment can both pass (a soft limit, like the team limits).
   */
  const billingDomainLimit = async (context: { userId: string; projectId: string }): Promise<number> => {
    const view = await viewOf(context.projectId);
    const accountLimit = toCustomDomainLimit(view.entitlements);
    if (accountLimit >= UNLIMITED_NUMBER || view.account.ownerId === null) return accountLimit;
    const others = await billing().usage.countCustomDomains({
      ownerKind: view.account.ownerKind,
      ownerId: view.account.ownerId,
      exceptProjectId: context.projectId,
    });
    return Math.max(0, accountLimit - others);
  };

  return {
    mode,
    entitlements: { getProjectEntitlements, getSearchPolicy },
    storageLimits: { getStorageLimits },
    searchPolicy: { getSearchPolicy },
    docsDomainLimit: {
      getLimit: (context) =>
        choose<number>({
          projectId: context.projectId,
          legacy: () => legacy.docsDomainLimit.getLimit(context),
          billing: () => billingDomainLimit(context),
          compare: (planValue, current) => (planValue < current ? [{ key: "site.custom_domains", limit: planValue, current }] : []),
        }),
    },
    teamSeats: {
      active: true,
      async assertSeatAvailable({ teamId, used }) {
        let view: AccountBillingView;
        try {
          const account = await billing().accounts.accountForOwner("team", teamId);
          view = await billing().entitlements.forAccount(account.id);
        } catch (cause) {
          if (mode === "on") throw cause;
          logShadowFailure(teamId, cause);
          return;
        }
        if (withinLimit(view.entitlements, "team.seats", used)) return;
        const raw = view.entitlements.limits["team.seats"];
        const limit = isUnlimited(raw) ? "unlimited" : raw;
        const plan = view.entitlements.plan;
        log({ key: "team.seats", mode, kind: "denied", plan, accountId: view.account.id, limit, used });
        // The team's account, so the upgrade link and dialog are for this team.
        if (mode === "on") throw new PlanLimitError({ key: "team.seats", limit, used, accountId: view.account.id, plan });
      },
    },
    projectLimit: {
      active: true,
      async assertProjectAvailable({ userId, teamId }) {
        const ownerKind = teamId === null ? "user" : "team";
        const ownerId = teamId ?? userId;
        let view: AccountBillingView;
        let used: number;
        try {
          const account = await billing().accounts.accountForOwner(ownerKind, ownerId);
          view = await billing().entitlements.forAccount(account.id);
          // An unlimited plan needs no count.
          if (isUnlimited(view.entitlements.limits["account.projects"])) return;
          used = await billing().usage.countProjects({ ownerKind, ownerId });
        } catch (cause) {
          if (mode === "on") throw cause;
          logShadowFailure(ownerId, cause);
          return;
        }
        if (withinLimit(view.entitlements, "account.projects", used)) return;
        const raw = view.entitlements.limits["account.projects"];
        const limit = isUnlimited(raw) ? "unlimited" : raw;
        const plan = view.entitlements.plan;
        log({ key: "account.projects", mode, kind: "denied", plan, accountId: view.account.id, limit, used });
        if (mode === "on") {
          throw new PlanLimitError({ key: "account.projects", limit, used, accountId: view.account.id, plan });
        }
      },
    },
    teamCreation: {
      active: true,
      async assertTeamCreationAllowed({ userId, ownedTeamIds }) {
        // No owned team: nothing to count, and billing is not built.
        if (ownedTeamIds.length === 0) return;
        const viewOf = async (ownerKind: "user" | "team", ownerId: string) =>
          billing().entitlements.forAccount((await billing().accounts.accountForOwner(ownerKind, ownerId)).id);
        let limit: number;
        let freeTeams: AccountBillingView[];
        try {
          limit = billing().catalog.teams.freeTeamsPerOwner;
          const teams = await Promise.all(ownedTeamIds.map((teamId) => viewOf("team", teamId)));
          if (teams.some(isPayingCustomer)) return;
          freeTeams = teams.filter((view) => view.entitlements.plan === "free");
          if (freeTeams.length < limit) return;
          // Read last: most users who reach this line have no paid personal account either.
          if (isPayingCustomer(await viewOf("user", userId))) return;
        } catch (cause) {
          if (mode === "on") throw cause;
          logShadowFailure(userId, cause);
          return;
        }
        const [oldestFree] = freeTeams;
        if (!oldestFree) return;
        const used = freeTeams.length;
        const accountId = oldestFree.account.id;
        log({ key: FREE_TEAMS_PER_OWNER_KEY, mode, kind: "denied", plan: "free", accountId, limit, used });
        if (mode === "on") {
          throw new PlanLimitError({ key: FREE_TEAMS_PER_OWNER_KEY, limit, used, accountId, plan: "free" });
        }
      },
    },
  };
}

async function legacyEntitlementsSearch(legacy: LegacySeams, projectId: string): Promise<PlanSearchPolicy> {
  if (legacy.entitlements.getSearchPolicy) return legacy.entitlements.getSearchPolicy(projectId);
  return legacy.searchPolicy.getSearchPolicy(projectId);
}

function logShadowFailure(subject: string, cause: unknown): void {
  const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error";
  console.warn(JSON.stringify({ service: "doxa-api", event: "billing.shadow_error", subject, message }));
}
