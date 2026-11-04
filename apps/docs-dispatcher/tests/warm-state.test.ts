import {
  WARM_POOLS,
  docsWarmStateKey,
  isWarmPoolDone,
  parseDocsWarmState,
} from "@doxahq/contracts/docs-warm-state";
import { describe, expect, test } from "vitest";

import { poolForRequest } from "../src/warm-pool";
import { readPoolWarmState } from "../src/warm-state";

const RELEASE = "c".repeat(64);

describe("visitor pool", () => {
  test.each([
    ["LAX", "us-west"],
    ["SJC", "us-west"],
    ["IAD", "us-east"],
    ["ORD", "us-east"],
    ["CDG", "eu-west"],
    ["MAD", "eu-west"],
    ["FRA", "eu-east"],
    ["ARN", "eu-east"],
    ["NRT", "asia-ne"],
    ["ICN", "asia-ne"],
    ["HKG", "hong-kong"],
    ["TPE", "hong-kong"],
    ["SIN", "singapore"],
    ["SYD", "oceania"],
    ["PER", "oceania"],
  ])("maps the measured colo %s to %s", (colo, pool) => {
    expect(poolForRequest({ colo })).toBe(pool);
  });

  test("prefers the colo table over the visitor's country", () => {
    expect(poolForRequest({ colo: "FRA", country: "FR" })).toBe("eu-east");
  });

  test.each<[string, Record<string, unknown>, string | null]>([
    ["a western US visitor", { colo: "PHX", continent: "NA", longitude: "-112.07" }, "us-west"],
    ["an eastern US visitor", { colo: "BOS", continent: "NA", longitude: "-71.06" }, "us-east"],
    ["a North American visitor without longitude", { continent: "NA" }, "us-east"],
    ["a South American visitor", { colo: "GRU", continent: "SA", country: "BR" }, "us-east"],
    ["an African visitor", { colo: "JNB", continent: "AF", country: "ZA" }, "eu-west"],
    ["a UK visitor", { colo: "LHR", continent: "EU", country: "GB" }, "eu-west"],
    ["a German visitor", { colo: "MUC", continent: "EU", country: "DE" }, "eu-east"],
    ["a western European visitor by longitude", { continent: "EU", country: "XX", longitude: "-8.6" }, "eu-west"],
    ["an eastern European visitor by longitude", { continent: "EU", country: "XX", longitude: 30.5 }, "eu-east"],
    ["a European visitor without longitude", { continent: "EU", country: "XX" }, null],
    ["a Middle East visitor", { colo: "DXB", continent: "AS", country: "AE" }, "eu-east"],
    ["a Japanese visitor at another colo", { colo: "FUK", country: "JP" }, "asia-ne"],
    ["a Malaysian visitor", { colo: "KUL", country: "MY" }, "singapore"],
    ["a New Zealand visitor", { colo: "AKL", continent: "OC", country: "NZ" }, "oceania"],
    ["an Indian visitor (pool not measured)", { colo: "BOM", continent: "AS", country: "IN" }, null],
    ["an Indonesian visitor (pool not measured)", { colo: "CGK", continent: "AS", country: "ID" }, null],
    ["an Antarctic visitor", { continent: "AN" }, null],
  ])("places %s", (_name, cf, pool) => {
    expect(poolForRequest(cf)).toBe(pool);
  });

  test.each([undefined, null, "CDG", 42, {}, { colo: 7, country: ["FR"] }])(
    "returns null for an unusable cf value %j",
    (cf) => {
      expect(poolForRequest(cf)).toBeNull();
    },
  );

  test("normalizes the colo case", () => {
    expect(poolForRequest({ colo: "cdg" })).toBe("eu-west");
  });
});

describe("warm state contract", () => {
  test("lists the eight S1 pools", () => {
    expect(WARM_POOLS).toEqual([
      "us-west",
      "us-east",
      "eu-west",
      "eu-east",
      "asia-ne",
      "hong-kong",
      "singapore",
      "oceania",
    ]);
  });

  test("keys the record by site in the hostname-map namespace", () => {
    expect(docsWarmStateKey("site-1")).toBe("warm:site-1");
  });

  test("parses a valid record with some pools", () => {
    const state = parseDocsWarmState({
      format: 1,
      releaseId: RELEASE,
      pools: { "us-east": 1, "eu-west": 2 },
    });
    expect(state).toEqual({
      format: 1,
      releaseId: RELEASE,
      pools: { "us-east": 1, "eu-west": 2 },
    });
    if (!state) throw new Error("Expected a record.");
    expect(isWarmPoolDone(state, RELEASE, "eu-west")).toBe(true);
    expect(isWarmPoolDone(state, RELEASE, "oceania")).toBe(false);
    expect(isWarmPoolDone(state, "d".repeat(64), "eu-west")).toBe(false);
  });

  test.each([
    ["another format", { format: 2, releaseId: RELEASE, pools: {} }],
    ["a malformed release", { format: 1, releaseId: "abc", pools: {} }],
    ["an unknown pool", { format: 1, releaseId: RELEASE, pools: { mumbai: 1 } }],
    ["a negative time", { format: 1, releaseId: RELEASE, pools: { "us-east": -1 } }],
    ["an extra field", { format: 1, releaseId: RELEASE, pools: {}, extra: 1 }],
    ["no pools", { format: 1, releaseId: RELEASE }],
    ["null", null],
  ])("rejects %s", (_name, value) => {
    expect(parseDocsWarmState(value)).toBeNull();
  });
});

describe("warm state reader", () => {
  const record = (value: unknown) => ({
    get: async (key: string) =>
      key === "warm:site-1" ? JSON.stringify(value) : null,
  });
  const read = (store: Parameters<typeof readPoolWarmState>[0]["store"]) =>
    readPoolWarmState({
      store,
      siteId: "site-1",
      releaseId: RELEASE,
      pool: "eu-west",
    });

  test("reports a done pool of the deployed release as warm", async () => {
    expect(
      await read(record({ format: 1, releaseId: RELEASE, pools: { "eu-west": 5 } })),
    ).toBe("warm");
  });

  test("reports cold, stale, missing, invalid, error and unbound", async () => {
    expect(
      await read(record({ format: 1, releaseId: RELEASE, pools: { "us-east": 5 } })),
    ).toBe("cold");
    expect(
      await read(record({ format: 1, releaseId: "d".repeat(64), pools: { "eu-west": 5 } })),
    ).toBe("stale");
    expect(await read({ get: async () => null })).toBe("missing");
    expect(await read({ get: async () => "{" })).toBe("invalid");
    expect(await read(record({ format: 1 }))).toBe("invalid");
    expect(
      await read({
        get: async () => {
          throw new Error("KV down");
        },
      }),
    ).toBe("error");
    expect(await read(undefined)).toBe("unbound");
  });
});
