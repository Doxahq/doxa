import type { AccountResolver, BillingAccount, BillingStore } from "@doxahq/billing";
import { ROLE_CAPABILITIES, type TeamRole } from "@doxahq/contracts/teams";

export type BillingCapability = "billing.read" | "billing.manage";

/** The teams side of billing access, from the `team_members` table. */
export interface BillingTeamDirectory {
  findRole(teamId: string, userId: string): Promise<TeamRole | null>;
  listForUser(userId: string): Promise<readonly { id: string; name: string; role: TeamRole }[]>;
}

export type BillingAccountAccessDecision =
  | { readonly allowed: true; readonly account: BillingAccount; readonly canManage: boolean }
  | { readonly allowed: false; readonly reason: "not_found" | "forbidden" };

export interface AccessibleBillingAccount {
  readonly account: BillingAccount;
  readonly name: string | null;
  readonly canManage: boolean;
}

/**
 * Who can do what on a billing account (billing spec 8.2 and 17):
 *
 * - a personal account: only its user, for reads and money actions;
 * - a team account: members whose role has the capability (owner and
 *   admin). Another member gets 403; anyone else gets 404, so the route
 *   never tells a stranger that the account exists.
 *
 * The account ID from the URL is resolved to its owner on every call; no
 * client field names the owner. No OAuth scope grants a billing capability,
 * so only a dashboard session reaches here.
 */
export class BillingAccountAccess {
  constructor(
    private readonly deps: {
      readonly store: Pick<BillingStore, "getAccount">;
      readonly accounts: Pick<AccountResolver, "accountForOwner">;
      readonly teams: BillingTeamDirectory;
      readonly acceptsAccountId: (id: string) => boolean;
    },
  ) {}

  async authorize(userId: string, accountId: string, capability: BillingCapability): Promise<BillingAccountAccessDecision> {
    if (!this.deps.acceptsAccountId(accountId)) return { allowed: false, reason: "not_found" };
    const account = await this.deps.store.getAccount(accountId);
    if (!account || account.ownerId === null) return { allowed: false, reason: "not_found" };
    if (account.ownerKind === "user") {
      return account.ownerId === userId ? { allowed: true, account, canManage: true } : { allowed: false, reason: "not_found" };
    }
    const role = await this.deps.teams.findRole(account.ownerId, userId);
    if (role === null) return { allowed: false, reason: "not_found" };
    if (!ROLE_CAPABILITIES[role].has(capability)) return { allowed: false, reason: "forbidden" };
    return { allowed: true, account, canManage: ROLE_CAPABILITIES[role].has("billing.manage") };
  }

  /** The team name of a team account the user is in, or null (the personal account). */
  async nameOf(userId: string, account: BillingAccount): Promise<string | null> {
    if (account.ownerKind !== "team" || account.ownerId === null) return null;
    const teams = await this.deps.teams.listForUser(userId);
    return teams.find((team) => team.id === account.ownerId)?.name ?? null;
  }

  /** `GET /billing/accounts`: the personal account and each team account with `billing.read`. */
  async list(userId: string): Promise<AccessibleBillingAccount[]> {
    const teams = (await this.deps.teams.listForUser(userId)).filter((team) => ROLE_CAPABILITIES[team.role].has("billing.read"));
    const personal = await this.deps.accounts.accountForOwner("user", userId);
    const teamAccounts = await Promise.all(
      teams.map(async (team) => ({
        account: await this.deps.accounts.accountForOwner("team", team.id),
        name: team.name,
        canManage: ROLE_CAPABILITIES[team.role].has("billing.manage"),
      })),
    );
    return [{ account: personal, name: null, canManage: true }, ...teamAccounts];
  }
}
