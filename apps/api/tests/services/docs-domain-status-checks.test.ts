import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, test, vi } from "vitest";
import { dueDomainCondition, type DueDomainCheck, type DueDomainWindows } from "../../src/repositories/docs-domain-checks";
import { DocsDomainStatusChecks, dueDomainWindows } from "../../src/services/docs-domain-status-checks";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const NOW = new Date("2026-10-08T12:00:00Z");

function setup(due: DueDomainCheck[], refresh = vi.fn(async () => null)) {
  const claimDue = vi.fn(async (_windows: DueDomainWindows) => due);
  const log = vi.fn();
  const checks = new DocsDomainStatusChecks({
    checks: { claimDue },
    domains: { refreshForProject: refresh },
    now: () => NOW,
    log,
  });
  return { checks, claimDue, refresh, log };
}

const domain = (id: string): DueDomainCheck => ({ domainId: id, projectId: `project-${id}`, ownerUserId: `owner-${id}` });

describe("DocsDomainStatusChecks", () => {
  test("refreshes each due domain as its project owner", async () => {
    const env = setup([domain("a"), domain("b")]);

    await expect(env.checks.run()).resolves.toEqual({ checked: 2, failed: 0 });
    expect(env.refresh).toHaveBeenNthCalledWith(1, { userId: "owner-a", projectId: "project-a", domainId: "a" });
    expect(env.refresh).toHaveBeenNthCalledWith(2, { userId: "owner-b", projectId: "project-b", domainId: "b" });
    expect(env.claimDue).toHaveBeenCalledWith(dueDomainWindows(NOW));
  });

  test("goes on after one domain fails", async () => {
    const refresh = vi.fn(async () => null).mockRejectedValueOnce(new Error("Cloudflare down"));
    const env = setup([domain("a"), domain("b")], refresh);

    await expect(env.checks.run()).resolves.toEqual({ checked: 2, failed: 1 });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(env.log).toHaveBeenCalledWith("docs_domain_check_failed", { domainId: "a", error: "Error" });
  });
});

describe("domain check schedule", () => {
  test("checks new pending domains every run, old ones hourly, and live ones daily", () => {
    const windows = dueDomainWindows(NOW);
    const minutesBefore = (date: Date) => (NOW.getTime() - date.getTime()) / 60_000;

    expect(minutesBefore(windows.newPendingCreatedAfter)).toBe(24 * 60);
    expect(minutesBefore(windows.newPendingCheckedBefore)).toBe(4);
    expect(minutesBefore(windows.oldPendingCheckedBefore)).toBe(59);
    expect(minutesBefore(windows.verifiedCheckedBefore)).toBe(24 * 60 - 1);
    expect(windows.limit).toBe(20);
  });

  test("reads only active, provisioned custom domains that are pending or verified", () => {
    const condition = dueDomainCondition(dueDomainWindows(NOW));
    if (!condition) throw new Error("expected a condition");
    const query = new PgDialect().sqlToQuery(condition);

    expect(query.params).toEqual(
      expect.arrayContaining(["custom_domain", "active", "pending", "verified"]),
    );
    expect(query.params).not.toContain("failed");
    expect(query.sql).toContain('"docs_domains"."provider_hostname_id" is not null');
    expect(query.sql).toContain('"docs_domains"."last_checked_at" is null');
  });
});
