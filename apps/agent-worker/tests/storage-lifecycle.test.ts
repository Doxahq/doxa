import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  PAGE_CACHE_PREFIX,
  R2_LIFECYCLE_RULES,
  STORAGE_GC_OWNED_PREFIXES,
  r2LifecycleAddCommand,
} from "@doxahq/contracts/storage-lifecycle";
import { describe, expect, test } from "vitest";
import { generationDiagnosticDraftKey } from "../src/generation-observability";
import { pageCacheKey } from "../src/generation-page-cache";

const RUNBOOK = resolve(
  __dirname,
  "../../../docs/current/storage-garbage-collection.md",
);

describe("R2 lifecycle rules", () => {
  test("each rule names one dedicated prefix, never the bucket root", () => {
    for (const rule of R2_LIFECYCLE_RULES) {
      expect(rule.prefix).toMatch(/^[a-z_][a-z0-9_-]*\/([a-z0-9_-]+\/)*$/);
      expect(rule.expireDays).toBeGreaterThan(0);
    }
    expect(new Set(R2_LIFECYCLE_RULES.map(({ id }) => id)).size).toBe(
      R2_LIFECYCLE_RULES.length,
    );
  });

  test("gives every prefix exactly one owner", () => {
    const prefixes: string[] = [
      ...R2_LIFECYCLE_RULES.map(({ prefix }) => prefix),
      ...STORAGE_GC_OWNED_PREFIXES,
    ];
    for (const [index, prefix] of prefixes.entries()) {
      for (const other of prefixes.slice(index + 1)) {
        expect(prefix.startsWith(other) || other.startsWith(prefix)).toBe(false);
      }
    }
  });

  test("covers the keys the generation writes", async () => {
    const owned = (key: string) =>
      R2_LIFECYCLE_RULES.some(({ prefix }) => key.startsWith(prefix));
    const pageKey = await pageCacheKey({
      siteId: "site-1",
      pageId: "overview",
      pageInputHash: "a".repeat(64),
      dependencyDigest: "b".repeat(64),
      routeRegistryHash: "e".repeat(64),
      documentationPolicyVersion: "public-v1",
      writingContract: "writing-v1",
    });

    expect(pageKey.startsWith(PAGE_CACHE_PREFIX)).toBe(true);
    expect(owned(pageKey)).toBe(true);
    expect(owned(generationDiagnosticDraftKey(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ))).toBe(true);
  });

  test("the runbook lists the install command of every rule", async () => {
    const runbook = await readFile(RUNBOOK, "utf8");
    for (const rule of R2_LIFECYCLE_RULES) {
      expect(runbook).toContain(r2LifecycleAddCommand(rule));
    }
  });
});
