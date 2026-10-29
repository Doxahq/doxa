import type { DocsWarmMessage } from "@doxahq/contracts/docs-warm-job";
import type { WarmPool } from "@doxahq/contracts/docs-warm-state";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { HostnameMapEntryLookup } from "../../src/hostname-map";
import { readWarmConfig } from "../../src/warm/warm-config";
import {
  processWarmMessage,
  type WarmConsumerDeps,
} from "../../src/warm/warm-consumer";
import type { WarmJob } from "../../src/warm/warm-job";
import type { SubmitOutcome } from "../../src/warm/warm-lock-state";
import {
  orderWarmPages,
  parseWarmPlan,
  readNavigationOrder,
} from "../../src/warm/warm-pages";
import { RELEASE, siteResolution, warmMessage } from "./fixtures";

afterEach(() => {
  vi.restoreAllMocks();
});

function hit(resolution = siteResolution(), resolvedAt = 5_000): HostnameMapEntryLookup {
  return { status: "hit", entry: { format: 1, resolvedAt, resolution } };
}

function createDeps(overrides: Partial<WarmConsumerDeps> = {}) {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  const started: { pool: WarmPool; job: WarmJob }[] = [];
  const deps = {
    config: readWarmConfig({ DOXA_PROD_WARM_MODE: "allowlist", DOXA_PROD_WARM_SITE_IDS: "site-1" }),
    deployedReleaseId: RELEASE,
    now: () => 50_000,
    readEntry: vi.fn(async (_hostname: string): Promise<HostnameMapEntryLookup> => hit()),
    submit: vi.fn(
      async (_input: { message: DocsWarmMessage; target: string; pools: WarmPool[] }): Promise<SubmitOutcome> =>
        "granted",
    ),
    reportPoolFailed: vi.fn(async (_message: DocsWarmMessage, _pool: WarmPool) => undefined),
    readPlan: vi.fn(async () => ["/", "/a", "/b", "/guide"]),
    readNavigation: vi.fn(async () => ["/guide", "/b"]),
    startPool: vi.fn(async (pool: WarmPool, job: WarmJob) => {
      started.push({ pool, job });
      return "started" as const;
    }),
    ...overrides,
  } satisfies WarmConsumerDeps;
  return { deps, started };
}

describe("warm consumer: drop, retry and ack", () => {
  test.each<[string, unknown, Partial<WarmConsumerDeps>, string]>([
    ["an invalid message", { v: 1, siteId: "site-1" }, {}, "invalid_message"],
    ["a site outside the rollout", warmMessage({ siteId: "site-2" }), {}, "not_in_rollout"],
    ["another release", warmMessage({ releaseId: "d".repeat(64) }), {}, "stale_release"],
    [
      "a missing entry",
      warmMessage({ reason: "deploy", publishedVersionId: undefined }),
      { readEntry: async () => ({ status: "miss" }) },
      "nothing_public",
    ],
    [
      "another site's entry",
      warmMessage({ publishedVersionId: undefined }),
      { readEntry: async () => hit(siteResolution({ siteId: "site-9" })) },
      "nothing_public",
    ],
    [
      "a preview entry",
      warmMessage({ publishedVersionId: undefined }),
      { readEntry: async () => hit(siteResolution({ renderTarget: "preview" })) },
      "nothing_public",
    ],
    [
      "a private entry",
      warmMessage({ publishedVersionId: undefined }),
      { readEntry: async () => hit(siteResolution({ accessPolicy: "authenticated" })) },
      "nothing_public",
    ],
    ["a running job (pending, newest wins)", warmMessage(), { submit: async () => "pending" }, "pending"],
    ["a duplicate target", warmMessage(), { submit: async () => "duplicate" }, "duplicate"],
    ["a target done within the hour", warmMessage(), { submit: async () => "done_recently" }, "done_recently"],
  ])("acks %s without warming", async (_name, body, overrides, outcome) => {
    const { deps } = createDeps(overrides);
    expect(await processWarmMessage(body, 1, deps)).toEqual({ action: "ack", outcome });
    expect(deps.startPool).not.toHaveBeenCalled();
    expect(deps.readPlan).not.toHaveBeenCalled();
  });

  test("retries while the hostname map does not show the published version", async () => {
    const { deps } = createDeps({
      readEntry: async () => hit(siteResolution({ publishedVersionId: "version-1" })),
    });
    for (const attempts of [1, 2, 3, 4, 5]) {
      expect(await processWarmMessage(warmMessage(), attempts, deps)).toEqual({
        action: "retry",
        delaySeconds: 30,
        outcome: "kv_behind",
      });
    }
    expect(deps.submit).not.toHaveBeenCalled();
    // The last delivery uses what the map holds (F7).
    expect(await processWarmMessage(warmMessage(), 6, deps)).toMatchObject({ action: "ack" });
    expect(deps.submit).toHaveBeenCalledTimes(1);
  });

  test("starts every pool from its anchor, the publisher's first, and reads the plan once", async () => {
    const { deps, started } = createDeps();
    const message = warmMessage({
      priority: { regions: ["oceania"], paths: ["/b", "/not-in-plan"] },
    });
    expect(await processWarmMessage(message, 1, deps)).toEqual({
      action: "ack",
      outcome: "granted:8/8",
    });
    expect(deps.readPlan).toHaveBeenCalledTimes(1);
    expect(started.map((entry) => entry.pool)).toEqual([
      "oceania",
      "us-east",
      "eu-west",
      "us-west",
      "asia-ne",
      "singapore",
      "hong-kong",
      "eu-east",
    ]);
    const job = started[0]?.job;
    expect(job).toMatchObject({
      jobId: message.jobId,
      siteId: "site-1",
      releaseId: RELEASE,
      pages: ["/", "/b", "/guide", "/a"],
      startedAt: 50_000,
    });
    expect(job?.targets).toEqual([
      { hostname: "docs.example.com", resolution: siteResolution(), resolvedAt: 5_000 },
    ]);
    const pools = vi.mocked(deps.submit).mock.calls[0]?.[0].pools;
    expect(pools?.[0]).toBe("oceania");
  });

  test("a message retry continues the same job", async () => {
    const { deps } = createDeps({ submit: vi.fn(async () => "continued" as const) });
    expect(await processWarmMessage(warmMessage(), 2, deps)).toEqual({
      action: "ack",
      outcome: "continued:8/8",
    });
  });

  test("reports a pool failed when its anchors are misplaced or fail", async () => {
    const { deps } = createDeps({
      startPool: vi.fn(async (pool: WarmPool) =>
        pool === "singapore" ? ("misplaced" as const) : pool === "oceania" ? Promise.reject(new Error("x")) : ("started" as const),
      ),
    });
    expect(await processWarmMessage(warmMessage(), 1, deps)).toEqual({
      action: "ack",
      outcome: "granted:6/8",
    });
    expect(vi.mocked(deps.reportPoolFailed).mock.calls.map((call) => call[1]).sort()).toEqual([
      "oceania",
      "singapore",
    ]);
  });

  test("caps the hostnames and keeps only this site's public entries", async () => {
    const { deps, started } = createDeps({
      readEntry: vi.fn(async (hostname: string) =>
        hostname === "other.example.com"
          ? hit(siteResolution({ siteId: "site-9", hostname }))
          : hit(siteResolution({ hostname })),
      ),
    });
    const message = warmMessage({
      hostnames: ["a.example.com", "other.example.com", "b.example.com", "c.example.com", "d.example.com"],
      publishedVersionId: undefined,
    });
    await processWarmMessage(message, 1, deps);
    expect(started[0]?.job.targets.map((target) => target.hostname)).toEqual([
      "a.example.com",
      "b.example.com",
      "c.example.com",
    ]);
  });

  test("a plan failure throws, so the queue retries", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { deps } = createDeps({ readPlan: vi.fn(async () => Promise.reject(new Error("runtime"))) });
    await expect(processWarmMessage(warmMessage(), 1, deps)).rejects.toThrow("runtime");
    expect(deps.startPool).not.toHaveBeenCalled();
  });
});

describe("warm pages (M45, D9)", () => {
  test("keeps only page entries of the plan", () => {
    expect(
      parseWarmPlan([
        { kind: "page", pathname: "/" },
        { kind: "page", pathname: "/guide/" },
        { kind: "redirect", pathname: "/api", target: "/api/intro", status: 308 },
        { kind: "live_only", pathname: "/x", reason: "unsupported_route" },
        { kind: "page", pathname: "/../etc" },
      ]),
    ).toEqual(["/", "/guide"]);
    expect(() => parseWarmPlan({ routes: [] })).toThrow();
  });

  test("orders home, changed pages, navigation, then the rest, capped", () => {
    expect(
      orderWarmPages({
        plan: ["/", "/a", "/b", "/c", "/guide"],
        navigation: ["/guide", "/c", "/elsewhere"],
        priorityPaths: ["/b/", "/zzz", "/"],
        maxPages: 4,
      }),
    ).toEqual(["/", "/b", "/guide", "/c"]);
    expect(
      orderWarmPages({ plan: ["/a"], navigation: [], priorityPaths: [], maxPages: 500 }),
    ).toEqual(["/a"]);
  });

  test("reads navigation order from sections and routes, never failing", async () => {
    const request = vi.fn(async (input: { operation: string; payload?: unknown }) => {
      if (input.operation === "getSections") {
        return {
          ok: true as const,
          data: [{ slug: "docs", default: true }, { slug: "api" }, { slug: "secret", hidden: true }],
        };
      }
      const section = (input.payload as { sectionSlug: string }).sectionSlug;
      if (section === "api") return { ok: false as const, error: { code: "x", message: "x" } };
      return { ok: true as const, data: [{ href: "/start" }, { href: "/start/install/" }, { title: "no href" }] };
    });
    const order = await readNavigationOrder({ request }, siteResolution());
    expect(order).toEqual(["/start", "/start/install"]);
    expect(request.mock.calls.map((call) => call[0].operation)).toEqual([
      "getSections",
      "getRoutes",
      "getRoutes",
    ]);
    expect(await readNavigationOrder({ request: vi.fn(async () => Promise.reject(new Error("down"))) }, siteResolution())).toEqual([]);
  });
});
