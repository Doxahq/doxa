import { CreditsExhaustedError, PlanLimitError, isUnlimited, type BillingEnforcement } from "@doxahq/billing";
import { ROLE_CAPABILITIES, type TeamRole } from "@doxahq/contracts/teams";
import type { Env } from "../../env";
import { AiAdmissionError } from "./generation-metering";
import { billingConfigFor } from "./config";
import { billingCoreFromEnv, type BillingCore } from "./core";
import { defaultBillingDenialLogger, type BillingDenialLogger } from "./enforcement";

/**
 * The billing side of the MCP server (billing spec 11 and 15.3). Worker-safe:
 * `@doxahq/billing` only, never `/payments` or a provider SDK. `doxa-mcp`
 * imports this module through the `@doxahq/api` exports map.
 */

export { AiAdmissionError, CreditsExhaustedError, PlanLimitError };

/** One account of `get_account` (spec 15.3). Credits, never USD model costs. */
export interface McpBillingAccount {
  readonly accountId: string;
  readonly ownerKind: "user" | "team";
  /** The team ID of a team account, else null. */
  readonly teamId: string | null;
  readonly plan: string;
  readonly credits: { readonly available: number; readonly resetsAt: string };
  readonly payg: { readonly active: boolean; readonly debt: number; readonly monthlyLimitCents: number };
  readonly toolCalls: { readonly today: number; readonly limit: number | "unlimited"; readonly resetsAt: string };
}

export interface McpBilling {
  readonly mode: BillingEnforcement;
  /**
   * Spec 11: one project tool call against the account's daily quota.
   * `on` throws `PlanLimitError` (403 `plan_limit`, `resetsAt` 00:00 UTC)
   * above the limit; `shadow` counts and logs only; `off` does nothing.
   */
  consumeToolCall(projectId: string): Promise<void>;
  /**
   * Spec 15.3: each account the user can read. Null with enforcement `off`
   * (the default): then no billing table is read or written, and
   * `get_account` has no `billing` field, as before billing. Empty when the
   * read fails.
   */
  accountsFor(userId: string, teams: readonly { id: string; role: TeamRole }[]): Promise<McpBillingAccount[] | null>;
}

export interface McpBillingDeps {
  readonly mode: BillingEnforcement;
  readonly core: () => BillingCore;
  readonly log?: BillingDenialLogger;
}

const TOOL_CALLS_KEY = "mcp.tool_calls_per_day";

export function createMcpBilling(deps: McpBillingDeps): McpBilling {
  let built: BillingCore | null = null;
  const core = () => (built ??= deps.core());
  const log = deps.log ?? defaultBillingDenialLogger;
  const { mode } = deps;

  async function readAccount(accountId: string, teamId: string | null): Promise<McpBillingAccount> {
    const { entitlements, ledger, quota, clock } = core();
    const view = await entitlements.forAccount(accountId);
    const balance = await ledger.balance(accountId, view.creditContext);
    const limit = view.entitlements.limits[TOOL_CALLS_KEY];
    const now = clock.now();
    const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
    return {
      accountId,
      ownerKind: view.account.ownerKind,
      teamId,
      plan: view.entitlements.plan,
      credits: { available: Math.max(0, balance.available), resetsAt: balance.windowEnd.toISOString() },
      payg: { active: balance.payg.active, debt: balance.openDebt, monthlyLimitCents: view.account.paygMonthlyLimitCents },
      toolCalls: {
        today: await quota.read("mcp.tool_calls", accountId),
        limit: isUnlimited(limit) ? "unlimited" : limit,
        resetsAt,
      },
    };
  }

  return {
    mode,
    async consumeToolCall(projectId) {
      if (mode === "off") return;
      let denial: PlanLimitError | null = null;
      try {
        const view = await core().entitlements.forProject(projectId);
        const result = await core().quota.consume("mcp.tool_calls", view.account.id, view.entitlements);
        if (result.allowed || result.unlimited) return;
        log({
          key: TOOL_CALLS_KEY,
          mode,
          kind: "denied",
          plan: view.entitlements.plan,
          projectId,
          accountId: view.account.id,
          limit: result.limit,
          used: result.count,
        });
        denial = new PlanLimitError({ key: TOOL_CALLS_KEY, limit: result.limit, used: result.count, resetsAt: result.resetsAt });
      } catch (cause) {
        // A billing outage never blocks a tool call.
        const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error";
        console.warn(JSON.stringify({ service: "doxa-mcp", event: "billing.quota_error", mode, projectId, message }));
        return;
      }
      if (mode === "on") throw denial;
    },
    async accountsFor(userId, teams) {
      // `ledger.balance` writes allowance grants: with enforcement off, touch nothing.
      if (mode === "off") return null;
      try {
        return await readAccounts(userId, teams);
      } catch (cause) {
        // get_account still answers who the connection acts for.
        const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error";
        console.warn(JSON.stringify({ service: "doxa-mcp", event: "billing.account_read_failed", mode, message }));
        return [];
      }
    },
  };

  async function readAccounts(userId: string, teams: readonly { id: string; role: TeamRole }[]): Promise<McpBillingAccount[]> {
      const { accounts } = core();
      const readable = teams.filter((team) => ROLE_CAPABILITIES[team.role].has("billing.read"));
      const personal = await accounts.accountForOwner("user", userId);
      const teamAccounts = await Promise.all(
        readable.map(async (team) => ({ account: await accounts.accountForOwner("team", team.id), teamId: team.id })),
      );
      return Promise.all([
        readAccount(personal.id, null),
        ...teamAccounts.map(({ account, teamId }) => readAccount(account.id, teamId)),
      ]);
  }
}

/** The MCP billing of one request env. With the defaults it builds no billing core. */
export function mcpBillingFromEnv(env: Env): McpBilling {
  const config = billingConfigFor(env);
  return createMcpBilling({ mode: config.enforcement, core: () => billingCoreFromEnv(env) });
}
