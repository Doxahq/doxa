import { DOCS_HOSTNAME_MAP_FORMAT } from "@doxahq/contracts/docs-hostname-map";
import type { DocsWarmMessage } from "@doxahq/contracts/docs-warm-job";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", async () => (await import("./fixtures")).cloudflareWorkersMock());

import { DocsHostCache } from "../../src/index";
import {
  applyHostnameMapUpdates,
  lookupHostnameMapEntry,
  type HostnameMapLiveChange,
} from "../../src/hostname-map";
import { readWarmConfig } from "../../src/warm/warm-config";
import { findSupersedeReason } from "../../src/warm/warm-supersede";
import { enqueuePublishWarm } from "../../src/warm/warm-trigger";
import { RELEASE, mapEntry, siteResolution, warmJob } from "./fixtures";

afterEach(() => {
  vi.restoreAllMocks();
});

function createStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
}

const NOW = Date.now();
const SITE_UUID = "9b2f4c1e-7a3d-4e5f-8a6b-1c2d3e4f5a6b";
const update = (resolution = siteResolution(), resolvedAt = NOW) => ({
  hostname: resolution.hostname,
  resolvedAt,
  resolution,
});

describe("syncHostnames: live change hook", () => {
  test("reports a new entry and a changed version, never an unchanged one or a delete", async () => {
    const store = createStore({
      "host:same.example.com": mapEntry(siteResolution({ hostname: "same.example.com" }), NOW - 1_000),
      "host:changed.example.com": mapEntry(
        siteResolution({ hostname: "changed.example.com", publishedVersionId: "version-1" }),
        NOW - 1_000,
      ),
    });
    const changes: HostnameMapLiveChange[] = [];
    await applyHostnameMapUpdates(
      store,
      {
        updates: [
          update(siteResolution({ hostname: "same.example.com" })),
          update(siteResolution({ hostname: "changed.example.com" })),
          update(siteResolution({ hostname: "new.example.com" })),
          { hostname: "gone.example.com", resolvedAt: NOW, resolution: null },
          update(siteResolution({ hostname: "preview.example.com", renderTarget: "preview" })),
        ],
      },
      { onLiveChange: (change) => changes.push(change), now: NOW },
    );
    expect(changes.map((change) => change.hostname).sort()).toEqual([
      "changed.example.com",
      "new.example.com",
    ]);
    expect(store.values.get("host:changed.example.com")).toContain("version-2");
  });

  test("reads nothing extra without the hook", async () => {
    const store = createStore();
    const sync = await applyHostnameMapUpdates(store, { updates: [update()], warm: { regions: ["eu-west"] } });
    expect(store.get).not.toHaveBeenCalled();
    expect(sync.warm).toEqual({ regions: ["eu-west"] });
  });

  test("an entry read keeps resolvedAt for the warm job", async () => {
    const store = createStore({ "host:docs.example.com": mapEntry(siteResolution(), NOW - 5) });
    expect(await lookupHostnameMapEntry(store, "docs.example.com", NOW)).toMatchObject({
      status: "hit",
      entry: { resolvedAt: NOW - 5 },
    });
    expect(await lookupHostnameMapEntry(store, "other.example.com", NOW)).toEqual({ status: "miss" });
    expect(await lookupHostnameMapEntry(undefined, "docs.example.com", NOW)).toEqual({ status: "unbound" });
  });
});

describe("publish trigger", () => {
  const change = (hostname: string, siteId = "site-1", resolvedAt = 1): HostnameMapLiveChange => ({
    hostname,
    resolvedAt,
    resolution: siteResolution({ hostname, siteId }),
  });
  const config = readWarmConfig({ DOXA_PROD_WARM_MODE: "allowlist", DOXA_PROD_WARM_SITE_IDS: "site-1,site-2" });

  test("sends one publish message per site, with the hint", async () => {
    const queue = { sendBatch: vi.fn(async (_messages: { body: DocsWarmMessage }[]) => undefined) };
    let id = 0;
    const result = await enqueuePublishWarm({
      changes: [change("a.example.com"), change("b.example.com"), change("c.example.com", "site-2"), change("x.example.com", "site-9")],
      hint: { regions: ["oceania"], paths: ["/guide"] },
      config,
      releaseId: RELEASE,
      queue,
      createJobId: () => `00000000-0000-4000-8000-00000000000${(id += 1)}`,
      now: 99,
    });
    expect(result).toEqual({ warmEnqueued: 2 });
    const bodies = queue.sendBatch.mock.calls[0]?.[0].map((message) => message.body);
    expect(bodies).toEqual([
      {
        v: 1,
        reason: "publish",
        siteId: "site-1",
        hostnames: ["a.example.com", "b.example.com"],
        releaseId: RELEASE,
        publishedVersionId: "version-2",
        jobId: "00000000-0000-4000-8000-000000000001",
        priority: { regions: ["oceania"], paths: ["/guide"] },
        enqueuedAt: 99,
      },
      expect.objectContaining({ siteId: "site-2", hostnames: ["c.example.com"] }),
    ]);
  });

  test("a failed send is reported, never thrown", async () => {
    const result = await enqueuePublishWarm({
      changes: [change("a.example.com")],
      hint: undefined,
      config,
      releaseId: RELEASE,
      queue: { sendBatch: async () => Promise.reject(new Error("queue down")) },
      createJobId: () => "00000000-0000-4000-8000-000000000001",
      now: 1,
    });
    expect(result).toMatchObject({ warmEnqueued: 0, skipped: "send_failed" });
  });

  test.each<[string, Partial<Parameters<typeof enqueuePublishWarm>[0]>, string]>([
    ["mode off", { config: readWarmConfig({}) }, "off"],
    ["no queue", { queue: undefined }, "no_queue"],
    ["no release", { releaseId: "unconfigured" }, "no_release"],
    ["no change", { changes: [] }, "no_change"],
  ])("sends nothing with %s", async (_name, overrides, skipped) => {
    const queue = { sendBatch: vi.fn(async () => undefined) };
    const result = await enqueuePublishWarm({
      changes: [change("a.example.com")],
      hint: undefined,
      config,
      releaseId: RELEASE,
      queue,
      createJobId: () => "00000000-0000-4000-8000-000000000001",
      now: 1,
      ...overrides,
    });
    expect(result).toEqual({ warmEnqueued: 0, skipped });
    expect(queue.sendBatch).not.toHaveBeenCalled();
  });

  test("DocsHostCache.syncHostnames writes the map even when the warm send fails", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const store = createStore();
    const host = new DocsHostCache({ props: { hostname: "x" } } as never, {
      DOCS_HOSTNAME_MAP: store,
      DOXA_PROD_WARM_MODE: "all",
      DOXA_RENDERER_RELEASE_ID: RELEASE,
      DOCS_WARM_PUBLISH_QUEUE: { sendBatch: async () => Promise.reject(new Error("down")) },
    } as never);
    await host.syncHostnames({ updates: [update()] });
    expect(store.values.has("host:docs.example.com")).toBe(true);
    const logged = info.mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(logged).toContainEqual(
      expect.objectContaining({
        event: "docs_hostname_map_sync",
        liveChanges: 1,
        warmEnqueued: 0,
        skipped: "send_failed",
      }),
    );
  });

  test("DocsHostCache.syncHostnames with the warm job off behaves as before", async () => {
    const store = createStore();
    const host = new DocsHostCache({ props: { hostname: "x" } } as never, {
      DOCS_HOSTNAME_MAP: store,
    } as never);
    await host.syncHostnames({ updates: [update()] });
    expect(store.get).not.toHaveBeenCalled();
    expect(store.put).toHaveBeenCalledTimes(1);
  });

  test("DocsHostCache.getWarmStatus answers an empty status without the lock binding", async () => {
    const host = new DocsHostCache({ props: { hostname: "x" } } as never, {} as never);
    expect(await host.getWarmStatus({ siteId: SITE_UUID })).toEqual({
      siteId: SITE_UUID,
      releaseId: null,
      startedAt: null,
      finishedAt: null,
      pools: [],
    });
    await expect(host.getWarmStatus({ siteId: "" })).rejects.toThrow();
  });

  test("DocsHostCache.getWarmStatus asks the site's lock", async () => {
    const getStatus = vi.fn(async () => ({ siteId: SITE_UUID, releaseId: RELEASE, startedAt: 1, finishedAt: null, pools: [] }));
    const idFromName = vi.fn((name: string) => name);
    const host = new DocsHostCache({ props: { hostname: "x" } } as never, {
      DOCS_WARM_LOCK: { idFromName, get: () => ({ getStatus }) },
    } as never);
    expect((await host.getWarmStatus({ siteId: SITE_UUID })).releaseId).toBe(RELEASE);
    expect(idFromName).toHaveBeenCalledWith(`site:${SITE_UUID}`);
  });

  test("FS-L3: getWarmStatus rejects a site ID that is not a UUID before any lock stub exists", async () => {
    const idFromName = vi.fn((name: string) => name);
    const host = new DocsHostCache({ props: { hostname: "x" } } as never, {
      DOCS_WARM_LOCK: { idFromName, get: vi.fn() },
    } as never);
    for (const siteId of ["site-1", "../x", "a".repeat(128), `${SITE_UUID}x`]) {
      await expect(host.getWarmStatus({ siteId })).rejects.toThrow();
    }
    expect(idFromName).not.toHaveBeenCalled();
  });

  test("FC-L6: a failed map write still warms the written hostnames, then fails the sync", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const store = createStore();
    store.put.mockImplementation(async (key: string, value: string) => {
      if (key === "host:bad.example.com") throw new Error("KV write failed");
      store.values.set(key, value);
    });
    const sent: DocsWarmMessage[] = [];
    const host = new DocsHostCache({ props: { hostname: "x" } } as never, {
      DOCS_HOSTNAME_MAP: store,
      DOXA_PROD_WARM_MODE: "all",
      DOXA_RENDERER_RELEASE_ID: RELEASE,
      DOCS_WARM_PUBLISH_QUEUE: {
        sendBatch: async (messages: { body: DocsWarmMessage }[]) =>
          void sent.push(...messages.map((message) => message.body)),
      },
    } as never);
    await expect(
      host.syncHostnames({
        updates: [
          update(siteResolution({ hostname: "good.example.com" })),
          update(siteResolution({ hostname: "bad.example.com" })),
        ],
      }),
    ).rejects.toThrow(/1 of 2 hostname map writes failed/);
    expect(store.values.has("host:good.example.com")).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.hostnames).toEqual(["good.example.com"]);
  });
});

describe("supersede check", () => {
  const config = readWarmConfig({ DOXA_PROD_WARM_MODE: "all" });
  const job = warmJob();
  const read = (lookup: Awaited<ReturnType<typeof lookupHostnameMapEntry>>) => async () => lookup;

  test.each<[string, Parameters<typeof findSupersedeReason>[1], string | null]>([
    ["nothing changed", { config, deployedReleaseId: RELEASE, readEntry: read({ status: "hit", entry: { format: DOCS_HOSTNAME_MAP_FORMAT, resolvedAt: 5_000, resolution: siteResolution() } }) }, null],
    ["a 12-hour rewrite of the same version", { config, deployedReleaseId: RELEASE, readEntry: read({ status: "hit", entry: { format: DOCS_HOSTNAME_MAP_FORMAT, resolvedAt: 9_999_999, resolution: siteResolution() } }) }, null],
    ["a newer version", { config, deployedReleaseId: RELEASE, readEntry: read({ status: "hit", entry: { format: DOCS_HOSTNAME_MAP_FORMAT, resolvedAt: 6_000, resolution: siteResolution({ publishedVersionId: "version-3" }) } }) }, "version_changed"],
    ["a removed hostname", { config, deployedReleaseId: RELEASE, readEntry: read({ status: "miss" }) }, "hostname_removed"],
    ["a read error", { config, deployedReleaseId: RELEASE, readEntry: read({ status: "error" }) }, null],
    ["a new renderer release", { config, deployedReleaseId: "d".repeat(64), readEntry: read({ status: "miss" }) }, "release_changed"],
    ["the warm flag turned off", { config: readWarmConfig({}), deployedReleaseId: RELEASE, readEntry: read({ status: "miss" }) }, "rollout_off"],
  ])("%s", async (_name, input, reason) => {
    expect(await findSupersedeReason(job, input)).toBe(reason);
  });
});
