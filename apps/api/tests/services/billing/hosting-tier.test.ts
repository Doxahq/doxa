import { subscriptionFixture } from "@doxahq/billing/testing";
import type { DocsDomainResolution } from "@doxahq/contracts";
import { describe, expect, test } from "vitest";
import { queueHostingTierRefresh, withHostingTier } from "../../../src/services/billing/hosting-tier";
import { createBillingHarness } from "../../support/billing-harness";

const PROJECT = "project-a";
const resolution: DocsDomainResolution = {
  siteId: "site-a",
  projectId: PROJECT,
  projectSlug: "acme",
  publishedVersionId: "version-1",
  artifactPrefix: "sites/site-a/versions/version-1",
  manifestPath: "sites/site-a/versions/version-1/manifest.json",
  accessPolicy: "public",
  hostname: "acme.doxa.page",
  domainKind: "doxa_subdomain",
  renderTarget: "production",
} as DocsDomainResolution;

function env(enforcement: string) {
  return { BILLING_ENFORCEMENT: enforcement, BILLING_PROVIDER: "memory" } as never;
}

describe("hosting tier of the host resolution (billing spec 9.4)", () => {
  test("off keeps the resolution exactly and never builds billing", async () => {
    let built = false;
    const result = await withHostingTier(env("off"), resolution, () => {
      built = true;
      throw new Error("must not build");
    });
    expect(result).toBe(resolution);
    expect(built).toBe(false);
  });

  test("on adds the tier of the site's plan", async () => {
    const harness = createBillingHarness({ enforcement: "on" });
    harness.billing.projects.set(PROJECT, { userId: "user-1" });
    await expect(withHostingTier(env("on"), resolution, () => harness.core)).resolves.toMatchObject({ hostingTier: "shared" });
    const account = await harness.core.accounts.accountForOwner("user", "user-1");
    await harness.billing.setSubscription(subscriptionFixture({ accountId: account.id }));
    await expect(withHostingTier(env("on"), resolution, () => harness.core)).resolves.toMatchObject({ hostingTier: "dedicated" });
  });

  test("shadow never changes the isolate: it logs the tier that on would send", async () => {
    const harness = createBillingHarness({ enforcement: "shadow" });
    harness.billing.projects.set(PROJECT, { userId: "user-1" });
    const lines: Readonly<Record<string, string | null>>[] = [];
    const result = await withHostingTier(env("shadow"), resolution, () => harness.core, (line) => lines.push(line));
    expect(result).toBe(resolution);
    expect(result).not.toHaveProperty("hostingTier");
    expect(lines).toEqual([expect.objectContaining({ event: "billing.hosting_tier_shadow", projectId: PROJECT, hostingTier: "shared" })]);
  });

  test("a plan change moves sites only with enforcement on", async () => {
    const core = () => {
      throw new Error("must not read billing");
    };
    await expect(queueHostingTierRefresh(env("off"), "acct_1", core)).resolves.toBe(0);
    await expect(queueHostingTierRefresh(env("shadow"), "acct_1", core)).resolves.toBe(0);
  });

  test("a preview keeps its shape, and a billing error never fails the request", async () => {
    const preview = { ...resolution, renderTarget: "preview" as const };
    await expect(withHostingTier(env("on"), preview, () => { throw new Error("x"); })).resolves.toBe(preview);
    await expect(withHostingTier(env("on"), resolution, () => { throw new Error("billing down"); })).resolves.toBe(resolution);
  });
});
