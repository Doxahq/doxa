import { describe, expect, it, vi } from "vitest";

import { estimateDocsSearchCost } from "../../../src/services/docs-search/cost";
import {
  createUsageQuery,
  readDailySearchUsage,
  rollUpSearchUsage,
} from "../../../src/services/docs-search/usage-rollup";
import { createDocsSearchIndexCollector } from "../../../src/services/storage-gc/collectors/docs-search-index";

const INDEX_KEY =
  "s_11111111111141118111111111111111_22222222222242228222222222222222_abcdef01abcdef01abcdef01abcdef01";
const resource = {
  siteId: "11111111-1111-4111-8111-111111111111",
  provider: "typesense" as const,
  indexKey: INDEX_KEY,
};

function collector(options: { inUse?: boolean } = {}) {
  const removeIndex = vi.fn(async () => {});
  return {
    removeIndex,
    collector: createDocsSearchIndexCollector({
      indexes: { isIndexInUse: async () => options.inUse ?? false },
      writers: {
        typesense: { writeIndex: vi.fn(), removeIndex, hasIndex: vi.fn() },
      },
    }),
  };
}

describe("search index collector", () => {
  it("keeps an index in use, and checks it again later", async () => {
    await expect(
      collector({ inUse: true }).collector.inspect(resource),
    ).resolves.toMatchObject({
      status: "retain",
      recheckAfterSeconds: expect.any(Number),
    });
  });

  it("removes only the index that the resource names", async () => {
    const { collector: gc, removeIndex } = collector();
    await expect(gc.inspect(resource)).resolves.toEqual({ status: "collect" });
    await gc.collect(resource);
    expect(removeIndex).toHaveBeenCalledWith(INDEX_KEY);
  });

  // SECURITY REGRESSION GUARDRAIL: an entry cannot reach another collection.
  it("refuses a resource that names something else", () => {
    const { collector: gc } = collector();
    expect(gc.parse(resource)).toEqual(resource);
    expect(() => gc.parse({ ...resource, extra: "other" })).toThrow();
    expect(() => gc.parse({ ...resource, indexKey: "t_real" })).toThrow();
    expect(() => gc.parse({ ...resource, siteId: "../other" })).toThrow();
    expect(() => gc.parse({ ...resource, provider: "minisearch" })).toThrow();
    // The index of another site.
    expect(() =>
      gc.parse({ ...resource, siteId: "33333333-3333-4333-8333-333333333333" }),
    ).toThrow();
  });
});

describe("search cost", () => {
  it("costs nothing for browser search", () => {
    expect(
      estimateDocsSearchCost({ provider: "minisearch", indexedBytes: 1e6, providerResponseBytes: 1e9 })
        .totalDollars,
    ).toBe(0);
  });

  it("charges the share of cluster RAM and the bandwidth", () => {
    const estimate = estimateDocsSearchCost({
      provider: "typesense",
      indexedBytes: 3.05 * 1024 * 500,
      providerResponseBytes: 1024 ** 3,
    });
    expect(estimate.bandwidthDollars).toBeCloseTo(0.09);
    expect(estimate.storageDollars).toBeGreaterThan(2);
    expect(estimate.storageDollars).toBeLessThan(4);
  });
});

describe("search usage rollup", () => {
  it("refuses anything but a date in the query", () => {
    expect(createUsageQuery("2026-11-05")).toContain("toDate('2026-11-05')");
    expect(() => createUsageQuery("2026-11-05'; DROP")).toThrow();
  });

  describe("after an outage", () => {
    const start = Date.parse("2026-11-07T12:00:00Z");
    const daysRead = (mock: ReturnType<typeof vi.fn>) =>
      mock.mock.calls.map(
        ([, init]) => /toDate\('(\d{4}-\d{2}-\d{2})'\)/.exec(String(init.body))?.[1],
      );
    const rollUp = (now: number, fetchMock: ReturnType<typeof vi.fn>) =>
      rollUpSearchUsage({
        accountId: "a",
        apiToken: "t",
        now,
        save: async () => {},
        fetch: fetchMock as unknown as typeof fetch,
      });

    it("reads the last seven days, oldest first", async () => {
      const fetchMock = vi.fn(async (..._args: [string, RequestInit]) =>
        Response.json({ data: [] }),
      );
      await rollUp(start, fetchMock);
      expect(daysRead(fetchMock)).toEqual([
        "2026-11-01",
        "2026-11-02",
        "2026-11-03",
        "2026-11-04",
        "2026-11-05",
        "2026-11-06",
        "2026-11-07",
      ]);
    });

    // PRODUCT REGRESSION GUARDRAIL: a day older than yesterday must not be lost.
    it("reads a missed day again when the rollup recovers", async () => {
      const failing = vi.fn(async (..._args: [string, RequestInit]) =>
        new Response("down", { status: 503 }),
      );
      await expect(rollUp(start, failing)).rejects.toThrow();

      const recovered = vi.fn(async (..._args: [string, RequestInit]) =>
        Response.json({ data: [] }),
      );
      await rollUp(start + 3 * 86_400_000, recovered);
      expect(daysRead(recovered)).toContain("2026-11-07");
    });
  });

  it("reads daily rows", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [
          {
            day: "2026-11-05",
            site_id: resource.siteId,
            provider: "typesense",
            outcome: "answered",
            events: "10",
            response_bytes: "2048.4",
            elapsed_ms_total: "50",
          },
        ],
      }),
    ) as unknown as typeof fetch;
    await expect(
      readDailySearchUsage({
        accountId: "a",
        apiToken: "t",
        day: "2026-11-05",
        fetch: fetchMock,
      }),
    ).resolves.toEqual([
      {
        day: "2026-11-05",
        siteId: resource.siteId,
        provider: "typesense",
        outcome: "answered",
        events: 10,
        responseBytes: 2048,
        elapsedMsTotal: 50,
      },
    ]);
  });
});
