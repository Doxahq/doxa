import { docsHostnameMapSyncSchema } from "@doxahq/contracts/docs-hostname-map";
import {
  docsWarmHintSchema,
  docsWarmMessageSchema,
  docsWarmStatusSchema,
} from "@doxahq/contracts/docs-warm-job";
import {
  DEFAULT_WARM_POOL_ORDER,
  WARM_POOL_COLOS,
  WARM_POOL_LOCATION_HINTS,
  isWarmPool,
  orderWarmPools,
  warmPoolForColo,
  warmPoolForLocation,
} from "@doxahq/contracts/docs-warm-region";
import { WARM_POOLS } from "@doxahq/contracts/docs-warm-state";
import { describe, expect, test } from "vitest";

import { poolForRequest } from "../../src/warm-pool";
import { RELEASE, warmMessage } from "./fixtures";

describe("warm queue message", () => {
  test("accepts a publish and a deploy message", () => {
    expect(docsWarmMessageSchema.parse(warmMessage())).toEqual(warmMessage());
    const deploy = warmMessage({ reason: "deploy" });
    delete deploy.publishedVersionId;
    expect(docsWarmMessageSchema.safeParse(deploy).success).toBe(true);
    expect(
      docsWarmMessageSchema.safeParse(
        warmMessage({ priority: { regions: ["eu-west"], paths: ["/", "/guide/setup"] } }),
      ).success,
    ).toBe(true);
  });

  test.each<[string, Record<string, unknown>]>([
    ["another version", { v: 2 }],
    ["an unknown reason", { reason: "continue" }],
    ["no hostname", { hostnames: [] }],
    ["eleven hostnames", { hostnames: Array.from({ length: 11 }, (_, i) => `h${i}.example.com`) }],
    ["a short release ID", { releaseId: "abc" }],
    ["an upper-case release ID", { releaseId: "C".repeat(64) }],
    ["a job ID that is not a UUID", { jobId: "job-1" }],
    ["an unknown pool", { priority: { regions: ["mars"] } }],
    ["51 paths", { priority: { paths: Array.from({ length: 51 }, (_, i) => `/p${i}`) } }],
    ["a path with a query", { priority: { paths: ["/guide?x=1"] } }],
    ["a relative path", { priority: { paths: ["guide"] } }],
    ["an extra field", { artifactPrefix: "sites/other" }],
    ["an extra hint field", { priority: { regions: [], resolution: {} } }],
  ])("rejects %s", (_name, change) => {
    expect(docsWarmMessageSchema.safeParse({ ...warmMessage(), ...change }).success).toBe(false);
  });

  test("the sync input carries an optional, validated warm hint", () => {
    expect(docsHostnameMapSyncSchema.parse({ updates: [] })).toEqual({ updates: [] });
    expect(
      docsHostnameMapSyncSchema.parse({ updates: [], warm: { regions: ["us-east"] } }),
    ).toEqual({ updates: [], warm: { regions: ["us-east"] } });
    expect(
      docsHostnameMapSyncSchema.safeParse({ updates: [], warm: { regions: ["moon"] } }).success,
    ).toBe(false);
    expect(docsWarmHintSchema.safeParse({ paths: ["/a"], hostnames: ["x"] }).success).toBe(false);
  });

  test("the status carries pool states and no content", () => {
    expect(
      docsWarmStatusSchema.parse({
        siteId: "site-1",
        releaseId: RELEASE,
        startedAt: 1,
        finishedAt: null,
        pools: [{ pool: "eu-west", state: "running", updatedAt: 2 }],
      }).pools,
    ).toHaveLength(1);
    expect(
      docsWarmStatusSchema.safeParse({
        siteId: "site-1",
        releaseId: null,
        startedAt: null,
        finishedAt: null,
        pools: [],
        hostnames: ["docs.example.com"],
      }).success,
    ).toBe(false);
  });
});

describe("warm region mapping (M45)", () => {
  test("every measured colo maps to its own pool", () => {
    for (const pool of WARM_POOLS) {
      for (const colo of WARM_POOL_COLOS[pool]) {
        expect(warmPoolForColo(colo)).toBe(pool);
        expect(warmPoolForLocation({ colo })).toBe(pool);
      }
    }
    expect(warmPoolForColo("BOM")).toBeNull();
    expect(warmPoolForColo(undefined)).toBeNull();
  });

  test("the dispatcher's visitor pool uses the same function", () => {
    for (const cf of [
      { colo: "SIN" },
      { continent: "NA", longitude: "-120" },
      { continent: "EU", country: "DE" },
      { colo: "BOM", country: "IN", continent: "AS" },
      null,
      "not-an-object",
    ]) {
      expect(poolForRequest(cf)).toBe(warmPoolForLocation(cf));
    }
  });

  test("location hints come from a fixed allowlist, one per pool", () => {
    expect(Object.keys(WARM_POOL_LOCATION_HINTS).sort()).toEqual([...WARM_POOLS].sort());
    for (const hint of Object.values(WARM_POOL_LOCATION_HINTS)) {
      expect(["wnam", "enam", "weur", "eeur", "apac", "apac-ne", "apac-se", "oc"]).toContain(hint);
    }
  });

  test("orders the publisher's pools first, each pool once", () => {
    expect(DEFAULT_WARM_POOL_ORDER).toEqual([
      "us-east",
      "eu-west",
      "us-west",
      "asia-ne",
      "singapore",
      "hong-kong",
      "eu-east",
      "oceania",
    ]);
    expect(orderWarmPools(["oceania", "eu-west"])).toEqual([
      "oceania",
      "eu-west",
      "us-east",
      "us-west",
      "asia-ne",
      "singapore",
      "hong-kong",
      "eu-east",
    ]);
    // A pool outside the configured list is never added by a hint.
    expect(orderWarmPools(["oceania"], ["us-east", "eu-west"])).toEqual(["us-east", "eu-west"]);
  });

  test("isWarmPool accepts only the eight names", () => {
    expect(isWarmPool("singapore")).toBe(true);
    expect(isWarmPool("Singapore")).toBe(false);
    expect(isWarmPool(1)).toBe(false);
  });
});
