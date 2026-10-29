import { describe, expect, test, vi } from "vitest";
import type { DocsDomainResolution } from "@doxahq/contracts";
import {
  DOCS_HOSTNAME_MAP_EXPIRATION_SECONDS,
  DOCS_HOSTNAME_MAP_MAX_AGE_SECONDS,
} from "@doxahq/contracts/docs-hostname-map";

import {
  applyHostnameMapUpdates,
  compareHostnameMap,
  lookupHostnameMap,
  parseHostnameMapMode,
  type HostnameMapStore,
} from "../src/hostname-map";

const NOW = Date.UTC(2026, 9, 28, 12);
const HOST = "docs.example.com";

const resolution: DocsDomainResolution = {
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

function memoryStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const puts: Array<{ key: string; ttl: number; siteId: string }> = [];
  const store: HostnameMapStore = {
    get: async (key) => values.get(key) ?? null,
    put: async (key, value, options) => {
      values.set(key, value);
      puts.push({
        key,
        ttl: options.expirationTtl,
        siteId: options.metadata.siteId,
      });
    },
    delete: async (key) => {
      values.delete(key);
    },
  };
  return { store, values, puts };
}

function storedEntry(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: 1,
    resolvedAt: NOW - 1_000,
    resolution,
    ...overrides,
  });
}

describe("hostname map mode", () => {
  test.each(["off", "shadow", "on"] as const)("accepts %s", (mode) => {
    expect(parseHostnameMapMode(mode)).toBe(mode);
  });

  test("defaults to off without a warning", () => {
    const warn = vi.fn();
    expect(parseHostnameMapMode(undefined, warn)).toBe("off");
    expect(warn).not.toHaveBeenCalled();
  });

  test.each(["all", "ON", "true", ""])(
    "fails closed to off for %j and warns",
    (value) => {
      const warn = vi.fn();
      expect(parseHostnameMapMode(value, warn)).toBe("off");
      expect(warn).toHaveBeenCalledOnce();
    },
  );
});

describe("hostname map reads", () => {
  test("returns a fresh public production entry for its hostname", async () => {
    const { store } = memoryStore({ [`host:${HOST}`]: storedEntry() });
    expect(await lookupHostnameMap(store, HOST, NOW)).toEqual({
      status: "hit",
      resolution,
    });
  });

  test("normalizes the hostname into the key", async () => {
    const { store } = memoryStore({ [`host:${HOST}`]: storedEntry() });
    expect((await lookupHostnameMap(store, "Docs.Example.com.", NOW)).status).toBe(
      "hit",
    );
  });

  test("misses without an entry or a binding", async () => {
    expect((await lookupHostnameMap(memoryStore().store, HOST, NOW)).status).toBe(
      "miss",
    );
    expect((await lookupHostnameMap(undefined, HOST, NOW)).status).toBe(
      "unbound",
    );
  });

  test("turns a read failure into a status", async () => {
    const store: HostnameMapStore = {
      get: async () => {
        throw new Error("KV GET failed: 503");
      },
      put: async () => {},
      delete: async () => {},
    };
    expect((await lookupHostnameMap(store, HOST, NOW)).status).toBe("error");
  });

  test.each([
    ["malformed JSON", "{"],
    ["an older format", storedEntry({ format: 0 })],
    ["an unknown field", storedEntry({ extra: true })],
    ["another hostname", storedEntry({ resolution: { ...resolution, hostname: "other.example.com" } })],
    ["a preview", storedEntry({ resolution: { ...resolution, renderTarget: "preview" } })],
    ["a generation snapshot", storedEntry({ resolution: { ...resolution, renderTarget: "generation_snapshot" } })],
    ["an authenticated site", storedEntry({ resolution: { ...resolution, accessPolicy: "authenticated" } })],
    ["a missing render target", storedEntry({ resolution: { ...resolution, renderTarget: undefined } })],
    ["a time in the future", storedEntry({ resolvedAt: NOW + 10 * 60 * 1000 })],
  ])("treats %s as invalid", async (_name, value) => {
    const { store } = memoryStore({ [`host:${HOST}`]: value });
    expect((await lookupHostnameMap(store, HOST, NOW)).status).toBe("invalid");
  });

  test("stops using an entry once it is older than the maximum age", async () => {
    const maxAgeMs = DOCS_HOSTNAME_MAP_MAX_AGE_SECONDS * 1000;
    const atLimit = memoryStore({
      [`host:${HOST}`]: storedEntry({ resolvedAt: NOW - maxAgeMs }),
    });
    const pastLimit = memoryStore({
      [`host:${HOST}`]: storedEntry({ resolvedAt: NOW - maxAgeMs - 1 }),
    });
    expect((await lookupHostnameMap(atLimit.store, HOST, NOW)).status).toBe("hit");
    expect((await lookupHostnameMap(pastLimit.store, HOST, NOW)).status).toBe(
      "expired",
    );
  });
});

describe("hostname map writes", () => {
  test("stores a public production resolution with an expiration", async () => {
    const { store, values, puts } = memoryStore();
    await applyHostnameMapUpdates(store, {
      updates: [{ hostname: HOST, resolvedAt: NOW, resolution }],
    });
    expect(JSON.parse(values.get(`host:${HOST}`) ?? "null")).toEqual({
      format: 1,
      resolvedAt: NOW,
      resolution,
    });
    expect(puts).toEqual([
      {
        key: `host:${HOST}`,
        ttl: DOCS_HOSTNAME_MAP_EXPIRATION_SECONDS,
        siteId: "site-1",
      },
    ]);
  });

  test("labels every entry with its site ID for the warm sweep (F26)", async () => {
    const { store, puts } = memoryStore();
    await applyHostnameMapUpdates(store, {
      updates: [
        { hostname: HOST, resolvedAt: NOW, resolution },
        {
          hostname: "demo.doxa.page",
          resolvedAt: NOW,
          resolution: {
            ...resolution,
            siteId: "site-2",
            hostname: "demo.doxa.page",
          },
        },
      ],
    });
    expect(
      puts.map(({ key, siteId }) => ({ key, siteId })).sort((a, b) =>
        a.key.localeCompare(b.key),
      ),
    ).toEqual([
      { key: "host:demo.doxa.page", siteId: "site-2" },
      { key: `host:${HOST}`, siteId: "site-1" },
    ]);
  });

  test.each([
    ["no resolution", null],
    ["a preview", { ...resolution, renderTarget: "preview" }],
    ["an authenticated site", { ...resolution, accessPolicy: "authenticated" }],
    ["another hostname's resolution", { ...resolution, hostname: "other.example.com" }],
  ])("deletes the entry for %s", async (_name, value) => {
    const { store, values, puts } = memoryStore({ [`host:${HOST}`]: storedEntry() });
    await applyHostnameMapUpdates(store, {
      updates: [{ hostname: HOST, resolvedAt: NOW, resolution: value }],
    });
    expect(values.has(`host:${HOST}`)).toBe(false);
    expect(puts).toEqual([]);
  });

  test("rejects malformed input without writing", async () => {
    const { store, puts } = memoryStore();
    await expect(
      applyHostnameMapUpdates(store, {
        updates: [{ hostname: HOST, resolvedAt: NOW, resolution, siteId: "x" }],
      }),
    ).rejects.toThrow();
    await expect(
      applyHostnameMapUpdates(store, {
        updates: Array.from({ length: 101 }, () => ({
          hostname: HOST,
          resolvedAt: NOW,
          resolution: null,
        })),
      }),
    ).rejects.toThrow();
    expect(puts).toEqual([]);
  });

  test("a written entry reads back as a hit", async () => {
    const { store } = memoryStore();
    await applyHostnameMapUpdates(store, {
      updates: [{ hostname: HOST, resolvedAt: NOW, resolution }],
    });
    expect(await lookupHostnameMap(store, HOST, NOW)).toEqual({
      status: "hit",
      resolution,
    });
  });
});

describe("shadow comparison", () => {
  const hit = { status: "hit", resolution } as const;

  test("agrees on the same resolution, whatever the key order", () => {
    const { siteId, hostname, ...rest } = resolution;
    const reordered: DocsDomainResolution = { hostname, ...rest, siteId };
    expect(compareHostnameMap(HOST, hit, reordered)).toBe("agree");
  });

  test("agrees on a miss for a hostname that is not public production", () => {
    expect(compareHostnameMap(HOST, { status: "miss" }, null)).toBe("agree");
    expect(
      compareHostnameMap(
        HOST,
        { status: "miss" },
        { ...resolution, renderTarget: "preview" },
      ),
    ).toBe("agree");
  });

  test("reports a missing entry for a public production hostname", () => {
    expect(compareHostnameMap(HOST, { status: "miss" }, resolution)).toBe(
      "missing",
    );
    expect(compareHostnameMap(HOST, { status: "expired" }, resolution)).toBe(
      "missing",
    );
  });

  test("reports another version or a hostname that stopped resolving", () => {
    expect(
      compareHostnameMap(HOST, hit, {
        ...resolution,
        publishedVersionId: "version-3",
      }),
    ).toBe("disagree");
    expect(compareHostnameMap(HOST, hit, null)).toBe("disagree");
  });

  test("reports a read failure", () => {
    expect(compareHostnameMap(HOST, { status: "error" }, resolution)).toBe(
      "error",
    );
    expect(compareHostnameMap(HOST, { status: "unbound" }, null)).toBe("error");
  });
});
