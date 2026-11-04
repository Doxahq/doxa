import { afterEach, describe, expect, test, vi } from "vitest";
import type { DocsDomainResolution } from "@doxahq/contracts";
import type { DocsHostnameMapSync as SyncInput } from "@doxahq/contracts/docs-hostname-map";

import {
  DocsHostnameMapReconciler,
  DocsHostnameMapSync,
  HOSTNAME_MAP_REFRESH_SLOTS,
  HostnameMapFullRewrite,
  hostnamesForTask,
  readHostnameMapUpdates,
  refreshSlotAt,
  refreshSlotOf,
  selectHostnamesDue,
  toHostnameMapUpdate,
  type DocsHostnameSource,
} from "../../src/services/docs-hostname-map";

const NOW = Date.UTC(2026, 9, 28, 12);
const FIVE_MINUTES = 5 * 60 * 1000;

function resolutionFor(
  hostname: string,
  overrides: Partial<DocsDomainResolution> = {},
): DocsDomainResolution {
  return {
    siteId: "site-1",
    projectId: "project-1",
    projectSlug: "demo",
    publishedVersionId: "version-2",
    artifactPrefix: "artifacts/v2",
    manifestPath: "artifacts/v2/manifest.json",
    accessPolicy: "public",
    hostname,
    domainKind: "custom_domain",
    renderTarget: "production",
    ...overrides,
  };
}

function fakeSource(input: {
  resolutions?: Record<string, DocsDomainResolution | null>;
  sites?: Record<string, string[]>;
  publicHostnames?: string[];
}) {
  const resolve = vi.fn(
    async (hostname: string) => input.resolutions?.[hostname] ?? null,
  );
  const source: DocsHostnameSource = {
    resolve,
    listSiteHostnames: async (siteId) => input.sites?.[siteId] ?? [],
    listPublicHostnames: async () => input.publicHostnames ?? [],
  };
  return { source, resolve };
}

function fakeRpc() {
  const calls: SyncInput[] = [];
  return {
    calls,
    rpc: {
      syncHostnames: async (sync: SyncInput) => {
        calls.push(sync);
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hostname map updates", () => {
  test("sends a public production resolution", () => {
    const resolution = resolutionFor("docs.acme.com");
    expect(toHostnameMapUpdate("docs.acme.com", resolution, NOW)).toEqual({
      hostname: "docs.acme.com",
      resolvedAt: NOW,
      resolution,
    });
  });

  test.each([
    ["a hostname that stopped resolving", null],
    ["a preview", resolutionFor("docs.acme.com", { renderTarget: "preview" })],
    [
      "a generation snapshot",
      resolutionFor("docs.acme.com", { renderTarget: "generation_snapshot" }),
    ],
    [
      "an authenticated site",
      resolutionFor("docs.acme.com", { accessPolicy: "authenticated" }),
    ],
    ["another hostname's resolution", resolutionFor("other.acme.com")],
  ])("sends a delete for %s", (_name, resolution) => {
    expect(
      toHostnameMapUpdate("docs.acme.com", resolution, NOW).resolution,
    ).toBeNull();
  });

  test("stamps each update before its database read", async () => {
    const order: string[] = [];
    const source = {
      resolve: async (hostname: string) => {
        order.push(`read ${hostname}`);
        return resolutionFor(hostname);
      },
    };
    let clock = NOW;
    const updates = await readHostnameMapUpdates(source, ["a.acme.com"], () => {
      order.push("stamp");
      return clock++;
    });
    expect(order).toEqual(["stamp", "read a.acme.com"]);
    expect(updates[0]?.resolvedAt).toBe(NOW);
  });

  test("covers the task hostname and every hostname of the site once", async () => {
    const { source } = fakeSource({
      sites: { "site-1": ["demo.doxa.page", "Docs.Acme.com.", "docs.acme.com"] },
    });
    expect(
      await hostnamesForTask(source, { siteId: "site-1", hostname: "old.acme.com" }),
    ).toEqual(["old.acme.com", "demo.doxa.page", "docs.acme.com"]);
    expect(
      await hostnamesForTask(source, { siteId: "gone", hostname: null }),
    ).toEqual([]);
  });
});

describe("hostname map sync for cache invalidation tasks", () => {
  test("writes current resolutions and deletes hostnames that stopped resolving", async () => {
    const { source } = fakeSource({
      resolutions: { "demo.doxa.page": resolutionFor("demo.doxa.page") },
      sites: { "site-1": ["demo.doxa.page"] },
    });
    const { rpc, calls } = fakeRpc();
    await new DocsHostnameMapSync(source, rpc, () => NOW).syncTask({
      siteId: "site-1",
      hostname: "removed.acme.com",
    });
    expect(calls).toEqual([
      {
        updates: [
          { hostname: "removed.acme.com", resolvedAt: NOW, resolution: null },
          {
            hostname: "demo.doxa.page",
            resolvedAt: NOW,
            resolution: resolutionFor("demo.doxa.page"),
          },
        ],
      },
    ]);
  });

  test("deletes every hostname of a deleted project", async () => {
    const { source } = fakeSource({});
    const { rpc, calls } = fakeRpc();
    const sync = new DocsHostnameMapSync(source, rpc, () => NOW);
    for (const hostname of [null, "demo.doxa.page", "docs.acme.com"]) {
      await sync.syncTask({ siteId: "deleted-site", hostname });
    }
    expect(calls.flatMap(({ updates }) => updates)).toEqual([
      { hostname: "demo.doxa.page", resolvedAt: NOW, resolution: null },
      { hostname: "docs.acme.com", resolvedAt: NOW, resolution: null },
    ]);
  });

  test("reads and writes each hostname once per claimed batch", async () => {
    const { source, resolve } = fakeSource({
      sites: { "site-1": ["demo.doxa.page", "docs.acme.com"] },
    });
    const { rpc, calls } = fakeRpc();
    const sync = new DocsHostnameMapSync(source, rpc, () => NOW);
    await sync.syncTask({ siteId: "site-1", hostname: null });
    await sync.syncTask({ siteId: "site-1", hostname: "docs.acme.com" });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(1);
  });

  test("retries a hostname whose write failed", async () => {
    const { source, resolve } = fakeSource({ sites: { "site-1": ["demo.doxa.page"] } });
    const syncHostnames = vi
      .fn<(input: SyncInput) => Promise<void>>()
      .mockRejectedValueOnce(new Error("KV PUT failed: 429"))
      .mockResolvedValue(undefined);
    const sync = new DocsHostnameMapSync(source, { syncHostnames }, () => NOW);
    await expect(sync.syncTask({ siteId: "site-1", hostname: null })).rejects.toThrow();
    await sync.syncTask({ siteId: "site-1", hostname: null });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(syncHostnames).toHaveBeenCalledTimes(2);
  });

  test("splits a large site into calls within the sync limit", async () => {
    const hostnames = Array.from({ length: 130 }, (_, index) => `h${index}.acme.com`);
    const { source } = fakeSource({ sites: { "site-1": hostnames } });
    const { rpc, calls } = fakeRpc();
    await new DocsHostnameMapSync(source, rpc, () => NOW).syncTask({
      siteId: "site-1",
      hostname: null,
    });
    expect(calls.map(({ updates }) => updates.length)).toEqual([100, 30]);
  });
});

describe("hostname map warm hint", () => {
  test("sends the publish's warm hint with every batch of the sync", async () => {
    const hostnames = Array.from({ length: 130 }, (_, index) => `h${index}.acme.com`);
    const { source } = fakeSource({ sites: { "site-1": hostnames } });
    const { rpc, calls } = fakeRpc();
    const warm = { regions: ["asia-ne" as const], paths: ["/guide"] };
    await new DocsHostnameMapSync(source, rpc, () => NOW, warm).syncTask({
      siteId: "site-1",
      hostname: null,
    });
    expect(calls.map((call) => call.warm)).toEqual([warm, warm]);
  });

  test("retries a batch once without the warm field when the call with it fails", async () => {
    // An older dispatcher's strict schema rejects the unknown `warm` field.
    const { source } = fakeSource({ sites: { "site-1": ["demo.doxa.page"] } });
    const calls: SyncInput[] = [];
    const rpc = {
      syncHostnames: async (sync: SyncInput) => {
        calls.push(sync);
        if (sync.warm) throw new Error("Unrecognized key: warm");
      },
    };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const warm = { regions: ["asia-ne" as const], paths: ["/guide"] };
    await new DocsHostnameMapSync(source, rpc, () => NOW, warm).syncTask({
      siteId: "site-1",
      hostname: null,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.warm).toEqual(warm);
    expect(calls[1]).not.toHaveProperty("warm");
    expect(calls[1]?.updates).toEqual(calls[0]?.updates);
  });

  test("fails the sync when the retry without warm fails too", async () => {
    const { source } = fakeSource({ sites: { "site-1": ["demo.doxa.page"] } });
    const syncHostnames = vi.fn(async () => {
      throw new Error("dispatcher down");
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const warm = { regions: ["asia-ne" as const], paths: ["/guide"] };
    await expect(
      new DocsHostnameMapSync(source, { syncHostnames }, () => NOW, warm).syncTask({
        siteId: "site-1",
        hostname: null,
      }),
    ).rejects.toThrow("dispatcher down");
    expect(syncHostnames).toHaveBeenCalledTimes(2);
  });

  test("does not retry a failed call that carried no warm field", async () => {
    const { source } = fakeSource({ sites: { "site-1": ["demo.doxa.page"] } });
    const syncHostnames = vi.fn(async () => {
      throw new Error("dispatcher down");
    });
    await expect(
      new DocsHostnameMapSync(source, { syncHostnames }, () => NOW).syncTask({
        siteId: "site-1",
        hostname: null,
      }),
    ).rejects.toThrow("dispatcher down");
    expect(syncHostnames).toHaveBeenCalledTimes(1);
  });

  test("sends no warm field without a hint", async () => {
    const { source } = fakeSource({ sites: { "site-1": ["demo.doxa.page"] } });
    const { rpc, calls } = fakeRpc();
    await new DocsHostnameMapSync(source, rpc, () => NOW).syncTask({
      siteId: "site-1",
      hostname: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("warm");
  });
});

describe("hostname map refresh slots", () => {
  const hostnames = Array.from({ length: 500 }, (_, index) => `site-${index}.doxa.page`);

  test("refreshes every hostname exactly once per refresh period", () => {
    const seen = new Map<string, number>();
    for (let run = 0; run < HOSTNAME_MAP_REFRESH_SLOTS; run += 1) {
      for (const hostname of selectHostnamesDue(hostnames, NOW + run * FIVE_MINUTES)) {
        seen.set(hostname, (seen.get(hostname) ?? 0) + 1);
      }
    }
    expect(seen.size).toBe(hostnames.length);
    expect(new Set(seen.values())).toEqual(new Set([1]));
  });

  test("has 144 slots: one refresh every 12 hours", () => {
    expect(HOSTNAME_MAP_REFRESH_SLOTS).toBe(144);
    expect(refreshSlotAt(NOW)).toBe(
      refreshSlotAt(NOW + HOSTNAME_MAP_REFRESH_SLOTS * FIVE_MINUTES),
    );
  });

  test("keeps a slot for every second of a scheduler run", () => {
    const start = Math.floor(NOW / FIVE_MINUTES) * FIVE_MINUTES;
    expect(refreshSlotAt(start)).toBe(refreshSlotAt(start + FIVE_MINUTES - 1));
    expect(refreshSlotAt(start)).not.toBe(refreshSlotAt(start + FIVE_MINUTES));
  });

  test("gives a hostname the same slot in any spelling", () => {
    expect(refreshSlotOf("Docs.Acme.com.")).toBe(refreshSlotOf("docs.acme.com"));
  });
});

function fullRewriteDone(): HostnameMapFullRewrite {
  const state = new HostnameMapFullRewrite();
  state.markDone();
  return state;
}

describe("hostname map reconcile", () => {
  test("rewrites the hostnames of the current slot from the database", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const due = ["a.doxa.page", "b.doxa.page", "c.doxa.page", "d.doxa.page"].filter(
      (hostname) => refreshSlotOf(hostname) === refreshSlotAt(NOW),
    );
    const other = Array.from({ length: 300 }, (_, index) => `x${index}.doxa.page`);
    const slotHostnames = other.filter((hostname) => refreshSlotOf(hostname) === refreshSlotAt(NOW));
    expect(slotHostnames.length).toBeGreaterThan(1);
    const { source, resolve } = fakeSource({
      publicHostnames: [...due, ...other],
      resolutions: Object.fromEntries(
        slotHostnames.slice(1).map((hostname) => [hostname, resolutionFor(hostname)]),
      ),
    });
    const { rpc, calls } = fakeRpc();
    const result = await new DocsHostnameMapReconciler(
      source,
      rpc,
      () => NOW,
      fullRewriteDone(),
    ).run(NOW);
    const expected = new Set([...due, ...slotHostnames]);
    expect(new Set(resolve.mock.calls.map(([hostname]) => hostname))).toEqual(expected);
    expect(result).toEqual({
      slot: refreshSlotAt(NOW),
      full: false,
      due: expected.size,
      stored: slotHostnames.length - 1,
      deleted: expected.size - (slotHostnames.length - 1),
    });
    expect(calls.flatMap(({ updates }) => updates)).toHaveLength(expected.size);
  });

  test("does nothing when no hostname is due", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { source } = fakeSource({ publicHostnames: [] });
    const { rpc, calls } = fakeRpc();
    expect(await new DocsHostnameMapReconciler(source, rpc).run(NOW)).toMatchObject({
      due: 0,
    });
    expect(calls).toEqual([]);
  });

  test("is not built without the dispatcher binding", () => {
    expect(DocsHostnameMapReconciler.fromEnv({} as never)).toBeNull();
  });
});

describe("hostname map full rewrite after a process start", () => {
  const hostnames = Array.from({ length: 230 }, (_, index) => `site-${index}.doxa.page`);
  const slotHostnames = selectHostnamesDue(hostnames, NOW);

  function publicSource() {
    return fakeSource({
      publicHostnames: hostnames,
      resolutions: Object.fromEntries(
        hostnames.map((hostname) => [hostname, resolutionFor(hostname)]),
      ),
    });
  }

  test("rewrites every public hostname on the first run, in sync-limit chunks", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { source } = publicSource();
    const { rpc, calls } = fakeRpc();
    const result = await new DocsHostnameMapReconciler(source, rpc, () => NOW).run(NOW);
    expect(result).toEqual({
      slot: refreshSlotAt(NOW),
      full: true,
      due: hostnames.length,
      stored: hostnames.length,
      deleted: 0,
    });
    expect(calls.map(({ updates }) => updates.length)).toEqual([100, 100, 30]);
    expect(new Set(calls.flatMap(({ updates }) => updates.map((update) => update.hostname)))).toEqual(
      new Set(hostnames),
    );
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({
      event: "docs_hostname_map_reconcile",
      full: true,
    });
  });

  test("rewrites only the due slot on the next run", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { source } = publicSource();
    const { rpc, calls } = fakeRpc();
    const reconciler = new DocsHostnameMapReconciler(source, rpc, () => NOW);
    await reconciler.run(NOW);
    calls.length = 0;
    const result = await reconciler.run(NOW + FIVE_MINUTES);
    const nextSlot = selectHostnamesDue(hostnames, NOW + FIVE_MINUTES);
    expect(result).toMatchObject({ full: false, due: nextSlot.length });
    expect(calls.flatMap(({ updates }) => updates.map((update) => update.hostname))).toEqual(nextSlot);
  });

  test("retries a failed full run as a full run on the next tick", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    expect(slotHostnames.length).toBeLessThan(hostnames.length);
    const { source } = publicSource();
    const syncHostnames = vi
      .fn<(input: SyncInput) => Promise<void>>()
      .mockRejectedValueOnce(new Error("dispatcher down"))
      .mockResolvedValue(undefined);
    const reconciler = new DocsHostnameMapReconciler(source, { syncHostnames }, () => NOW);
    await expect(reconciler.run(NOW)).rejects.toThrow("dispatcher down");
    const retry = await reconciler.run(NOW + FIVE_MINUTES);
    expect(retry).toMatchObject({ full: true, due: hostnames.length });
    expect((await reconciler.run(NOW + 2 * FIVE_MINUTES)).full).toBe(false);
  });

  test("shares one process state across reconcilers built per tick", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { source } = publicSource();
    const { rpc } = fakeRpc();
    const state = new HostnameMapFullRewrite();
    expect((await new DocsHostnameMapReconciler(source, rpc, () => NOW, state).run(NOW)).full).toBe(true);
    expect(
      (await new DocsHostnameMapReconciler(source, rpc, () => NOW, state).run(NOW + FIVE_MINUTES))
        .full,
    ).toBe(false);
  });
});
