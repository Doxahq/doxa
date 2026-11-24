import { readBillingConfig, type BillingEnforcement, type OwnerKind } from "@doxahq/billing";
import { createTestBilling, type TestBilling } from "@doxahq/billing/testing";
import type { TeamRole } from "@doxahq/contracts/teams";
import type { BillingContactDirectory, BillingRunHistory } from "../../src/repositories/billing-ownership";
import { createBillingPaymentsRuntime } from "../../src/runtime/node/billing";
import { BillingAccountAccess, type BillingTeamDirectory } from "../../src/services/billing/account-access";
import { createBillingCore, type BillingCore } from "../../src/services/billing/core";
import type { BillingPaymentsRuntime } from "../../src/services/billing/payments-port";
import type { BillingRouteServices } from "../../src/routes/billing";

/** Teams and members for billing access, in memory. */
export class MemoryBillingTeams implements BillingTeamDirectory {
  readonly roles = new Map<string, Map<string, TeamRole>>();
  readonly names = new Map<string, string>();

  add(teamId: string, name: string, members: Record<string, TeamRole>): void {
    this.names.set(teamId, name);
    this.roles.set(teamId, new Map(Object.entries(members)));
  }

  async findRole(teamId: string, userId: string): Promise<TeamRole | null> {
    return this.roles.get(teamId)?.get(userId) ?? null;
  }

  async listForUser(userId: string) {
    return [...this.roles.entries()].flatMap(([id, members]) => {
      const role = members.get(userId);
      return role ? [{ id, name: this.names.get(id) ?? id, role }] : [];
    });
  }
}

/** Custom domains of each project, for the account-wide domain limit, and the project count. */
export class MemoryBillingUsage {
  readonly domains = new Map<string, number>();

  constructor(private readonly billing: TestBilling) {}

  async countProjects(input: { ownerKind: OwnerKind; ownerId: string }): Promise<number> {
    let total = 0;
    for (const owner of this.billing.projects.projects.values()) {
      const matches = input.ownerKind === "team" ? owner.teamId === input.ownerId : owner.userId === input.ownerId && owner.teamId === null;
      if (matches) total += 1;
    }
    return total;
  }

  async countCustomDomains(input: { ownerKind: OwnerKind; ownerId: string; exceptProjectId: string }): Promise<number> {
    let total = 0;
    for (const [projectId, owner] of this.billing.projects.projects) {
      if (projectId === input.exceptProjectId) continue;
      const matches = input.ownerKind === "team" ? owner.teamId === input.ownerId : owner.userId === input.ownerId && owner.teamId === null;
      if (matches) total += this.domains.get(projectId) ?? 0;
    }
    return total;
  }
}

export interface BillingHarness {
  readonly billing: TestBilling;
  readonly core: BillingCore;
  readonly teams: MemoryBillingTeams;
  readonly usage: MemoryBillingUsage;
  readonly payments: BillingPaymentsRuntime;
  readonly jobIds: Map<string, string[]>;
  readonly logs: { event: string; fields: Readonly<Record<string, unknown>> }[];
  services(options?: { payments?: boolean }): BillingRouteServices;
}

/** The API billing composition over the memory store and the memory provider. */
export function createBillingHarness(options: { provider?: "memory" | "none"; enforcement?: BillingEnforcement } = {}): BillingHarness {
  const billing = createTestBilling();
  const config = readBillingConfig(
    { BILLING_PROVIDER: options.provider ?? "memory", BILLING_ENFORCEMENT: options.enforcement ?? "on" },
    { dashboardUrl: "https://doxa.test" },
  );
  const usage = new MemoryBillingUsage(billing);
  const core = createBillingCore({
    config,
    store: billing.store,
    projects: billing.projects,
    usage,
    clock: billing.clock,
    catalog: billing.catalog,
    acceptsAccountId: (id) => /^[a-z]+_\d+$/.test(id),
    meterEvents: { count: (name, fields) => billing.counters.push({ name, fields }) },
  });
  const teams = new MemoryBillingTeams();
  const logs: BillingHarness["logs"] = [];
  const memoryPayments = createBillingPaymentsRuntime({
    provider: billing.provider,
    core: () => core,
    log: (event, fields) => logs.push({ event, fields }),
  });
  // `none` (self-hosted): the routes see only the provider name. Tests do not
  // import `@doxahq/billing/payments` (spec 6.2), so the none provider stays out.
  const payments: BillingPaymentsRuntime = options.provider === "none" ? { ...memoryPayments, providerName: "none" } : memoryPayments;
  const contacts: BillingContactDirectory = {
    billingContactOf: async ({ ownerKind, ownerId }) =>
      ownerId ? { email: `${ownerKind}-owner-${ownerId}@example.com`, name: ownerKind === "user" ? ownerId : null } : null,
  };
  const jobIds = new Map<string, string[]>();
  const history: BillingRunHistory = { recentJobIds: async (projectId, limit) => (jobIds.get(projectId) ?? []).slice(0, limit) };
  const access = new BillingAccountAccess({ store: core.store, accounts: core.accounts, teams, acceptsAccountId: core.acceptsAccountId });
  return {
    billing,
    core,
    teams,
    usage,
    payments,
    jobIds,
    logs,
    services: (choice = {}) => ({ core, access, payments: choice.payments === false ? null : payments, contacts, history }),
  };
}
