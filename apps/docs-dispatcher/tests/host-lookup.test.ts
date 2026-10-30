import { DOCS_HOSTNAME_MAP_FORMAT } from "@doxahq/contracts/docs-hostname-map";
import { describe, expect, test, vi } from "vitest";
import type { DocsDomainResolution } from "@doxahq/contracts";

import {
  hostSourceFor,
  lookupHost,
  type HostCacheRead,
} from "../src/host-lookup";
import type { HostnameMapStore } from "../src/hostname-map";

const NOW = Date.UTC(2026, 9, 28, 12);
const HOST = "docs.example.com";

const current: DocsDomainResolution = {
  siteId: "site-1",
  projectId: "project-1",
  projectSlug: "demo",
  publishedVersionId: "version-2",
  artifactPrefix: "artifacts/v2",
  manifestPath: "artifacts/v2/manifest.json",
  accessPolicy: "public",
  hostname: HOST,
  domainKind: "custom_domain",
  renderTarget: "production",
};
const previous: DocsDomainResolution = {
  ...current,
  publishedVersionId: "version-1",
  artifactPrefix: "artifacts/v1",
  manifestPath: "artifacts/v1/manifest.json",
};

function mapWith(resolution: DocsDomainResolution | null) {
  const get = vi.fn(async () =>
    resolution
      ? JSON.stringify({ format: DOCS_HOSTNAME_MAP_FORMAT, resolvedAt: NOW - 1_000, resolution })
      : null,
  );
  const store: HostnameMapStore = {
    get,
    put: async () => {},
    delete: async () => {},
  };
  return { store, get };
}

function hostCache(resolution: DocsDomainResolution | null, cacheStatus = "HIT") {
  return vi.fn(
    async (): Promise<HostCacheRead> => ({ resolution, cacheStatus }),
  );
}

describe("host lookup", () => {
  test("off: reads only the host cache", async () => {
    const map = mapWith(previous);
    const readHostCache = hostCache(current);
    const lookup = await lookupHost({
      hostname: HOST,
      mode: "off",
      store: map.store,
      now: NOW,
      readHostCache,
    });
    expect(lookup).toEqual({
      resolution: current,
      facts: { source: "cache", hostCacheStatus: "HIT" },
    });
    expect(map.get).not.toHaveBeenCalled();
  });

  test("on: a map hit skips the host cache", async () => {
    const readHostCache = hostCache(previous);
    const lookup = await lookupHost({
      hostname: HOST,
      mode: "on",
      store: mapWith(current).store,
      now: NOW,
      readHostCache,
    });
    expect(lookup).toEqual({
      resolution: current,
      facts: {
        source: "kv",
        hostCacheStatus: "BYPASS",
        hostnameMap: { mode: "on", status: "hit" },
      },
    });
    expect(readHostCache).not.toHaveBeenCalled();
  });

  test("on: a map miss falls back to the resolver through the host cache", async () => {
    const lookup = await lookupHost({
      hostname: HOST,
      mode: "on",
      store: mapWith(null).store,
      now: NOW,
      readHostCache: hostCache(current, "MISS"),
    });
    expect(lookup).toEqual({
      resolution: current,
      facts: {
        source: "resolver",
        hostCacheStatus: "MISS",
        hostnameMap: { mode: "on", status: "miss" },
      },
    });
  });

  test("on: a map read failure or a missing binding falls back", async () => {
    const failing: HostnameMapStore = {
      get: async () => {
        throw new Error("KV unavailable");
      },
      put: async () => {},
      delete: async () => {},
    };
    for (const store of [failing, undefined]) {
      const lookup = await lookupHost({
        hostname: HOST,
        mode: "on",
        store,
        now: NOW,
        readHostCache: hostCache(current),
      });
      expect(lookup.resolution).toEqual(current);
      expect(lookup.facts.source).toBe("cache");
    }
  });

  test("on: a host cache failure still fails the request after a map miss", async () => {
    await expect(
      lookupHost({
        hostname: HOST,
        mode: "on",
        store: mapWith(null).store,
        now: NOW,
        readHostCache: async () => {
          throw new Error("Hostname cache lookup failed");
        },
      }),
    ).rejects.toThrow("Hostname cache lookup failed");
  });

  test("shadow: serves the host cache answer and reports agreement", async () => {
    const lookup = await lookupHost({
      hostname: HOST,
      mode: "shadow",
      store: mapWith(current).store,
      now: NOW,
      readHostCache: hostCache(current),
    });
    expect(lookup).toEqual({
      resolution: current,
      facts: {
        source: "cache",
        hostCacheStatus: "HIT",
        hostnameMap: { mode: "shadow", status: "hit", agreement: "agree" },
      },
    });
  });

  test("shadow: never serves a disagreeing map entry", async () => {
    const lookup = await lookupHost({
      hostname: HOST,
      mode: "shadow",
      store: mapWith(previous).store,
      now: NOW,
      readHostCache: hostCache(current),
    });
    expect(lookup.resolution).toEqual(current);
    expect(lookup.facts.hostnameMap).toEqual({
      mode: "shadow",
      status: "hit",
      agreement: "disagree",
    });
  });

  test("shadow: reports a public hostname that the map lacks", async () => {
    const lookup = await lookupHost({
      hostname: HOST,
      mode: "shadow",
      store: mapWith(null).store,
      now: NOW,
      readHostCache: hostCache(current, "MISS"),
    });
    expect(lookup.facts).toEqual({
      source: "resolver",
      hostCacheStatus: "MISS",
      hostnameMap: { mode: "shadow", status: "miss", agreement: "missing" },
    });
  });
});

describe("host source", () => {
  test.each([
    ["HIT", "cache"],
    ["STALE", "cache"],
    ["UPDATING", "cache"],
    ["MISS", "resolver"],
    ["EXPIRED", "resolver"],
    ["REVALIDATED", "resolver"],
    ["UNAVAILABLE", "resolver"],
  ])("%s → %s", (status, source) => {
    expect(hostSourceFor(status)).toBe(source);
  });
});
