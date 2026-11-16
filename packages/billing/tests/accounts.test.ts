import { describe, expect, it } from "vitest";

import { BillingNotFoundError } from "../src/index";
import { createTestBilling } from "../src/testing";

describe("resolveBillingAccount", () => {
  it("bills a team project to the team, else to the owner's personal account", async () => {
    const billing = createTestBilling();
    billing.projects.set("p_personal", { userId: "u1" });
    billing.projects.set("p_team", { userId: "u1", teamId: "t1" });
    const personal = await billing.accounts.resolveBillingAccount("p_personal");
    const team = await billing.accounts.resolveBillingAccount("p_team");
    expect(personal).toMatchObject({ ownerKind: "user", ownerId: "u1", planKey: "free", paygEnabled: true, paygMonthlyLimitCents: 3_000 });
    expect(team).toMatchObject({ ownerKind: "team", ownerId: "t1" });
    expect(team.id).not.toBe(personal.id);
  });

  it("creates one account for each owner, also under concurrent first use", async () => {
    const billing = createTestBilling();
    billing.projects.set("p", { userId: "u1" });
    const accounts = await Promise.all(Array.from({ length: 10 }, () => billing.accounts.resolveBillingAccount("p")));
    expect(new Set(accounts.map((account) => account.id)).size).toBe(1);
  });

  it("changes account when a project moves into a team", async () => {
    const billing = createTestBilling();
    billing.projects.set("p", { userId: "u1" });
    const before = await billing.accounts.resolveBillingAccount("p");
    billing.projects.set("p", { userId: "u1", teamId: "t9" });
    const after = await billing.accounts.resolveBillingAccount("p");
    expect(after.id).not.toBe(before.id);
    expect((await billing.entitlements.forProject("p")).account.id).toBe(after.id);
  });

  it("fails for an unknown project", async () => {
    await expect(createTestBilling().accounts.resolveBillingAccount("nope")).rejects.toBeInstanceOf(BillingNotFoundError);
  });
});
