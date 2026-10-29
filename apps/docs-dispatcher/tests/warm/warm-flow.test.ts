import type { DocsWarmMessage } from "@doxahq/contracts/docs-warm-job";
import { WARM_POOL_COLOS, WARM_POOL_LOCATION_HINTS } from "@doxahq/contracts/docs-warm-region";
import { WARM_POOLS, docsWarmStateKey, docsWarmStateSchema } from "@doxahq/contracts/docs-warm-state";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", async () => (await import("./fixtures")).cloudflareWorkersMock());

import worker, {
  DocsHostCache,
  DocsRegionalWarmer,
  DocsWarmAnchor,
  DocsWarmControl,
  DocsWarmLock,
} from "../../src/index";
import type { WarmQueueMessage } from "../../src/warm/warm-handlers";
import {
  createSimulatedWorld,
  resolution,
  visitorRequest,
} from "../fixtures/simulated-cache";
import { MemoryStorage } from "./fixtures";

/**
 * The whole warm job on in-memory Durable Objects: a publish sync sends a
 * message, the consumer starts every pool's anchor, each regional warmer
 * fills the site through the dispatcher's own cache entrypoints, and the
 * site lock writes `warm:{siteId}`. The next visitor reads a HIT.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const HINT_COLOS = Object.fromEntries(
  WARM_POOLS.map((pool) => [WARM_POOL_LOCATION_HINTS[pool], WARM_POOL_COLOS[pool][0]]),
);

type ObjectClass = new (state: never, env: never) => object;

function createFlow(overrides: Record<string, string> = {}) {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const world = createSimulatedWorld({
    DOXA_PROD_PREVIOUS_FALLBACK_MODE: "off",
    DOXA_PROD_WARM_MODE: "allowlist",
    DOXA_PROD_WARM_SITE_IDS: "site-1",
    DOXA_DOCS_BASE_DOMAIN: "doxa.page",
    ...overrides,
  });
  const kv = new Map<string, string>();
  const publishQueue: DocsWarmMessage[] = [];
  const sweepQueue: DocsWarmMessage[] = [];
  const instances = new Map<string, object>();
  const storages = new Map<string, MemoryStorage>();

  const namespace = (kind: string, Class: ObjectClass) => ({
    idFromName: (name: string) => ({ toString: () => `${kind}/${name}` }),
    get: (id: { toString(): string }, options?: { locationHint?: string }) => {
      const key = id.toString();
      let instance = instances.get(key);
      if (!instance) {
        const storage = new MemoryStorage();
        storages.set(key, storage);
        // An anchor's colo follows its location hint; a warmer has none.
        if (options?.locationHint) storage.values.set("colo", HINT_COLOS[options.locationHint]);
        instance = new Class(
          {
            storage,
            id: { toString: () => key },
            exports: world.ctx.exports,
            waitUntil: () => undefined,
          } as never,
          world.env as never,
        );
        instances.set(key, instance);
      }
      return instance;
    },
  });

  Object.assign(world.env, {
    DOCS_HOSTNAME_MAP: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => void kv.set(key, value),
      delete: async (key: string) => void kv.delete(key),
      list: async () => ({
        keys: [...kv.keys()].filter((key) => key.startsWith("host:")).map((name) => ({ name, metadata: { siteId: "site-1" } })),
        list_complete: true,
      }),
    },
    DOCS_RUNTIME: {
      request: vi.fn(async (input: { operation: string }) => {
        switch (input.operation) {
          case "getPrerenderPlan":
            return {
              ok: true,
              data: [
                { kind: "page", pathname: "/" },
                { kind: "page", pathname: "/guide" },
                { kind: "redirect", pathname: "/api", target: "/guide", status: 308 },
              ],
            };
          case "getSections":
            return { ok: true, data: [{ slug: "docs", default: true }] };
          case "getRoutes":
            return { ok: true, data: [{ href: "/guide" }] };
          default:
            return { ok: false, error: { code: "unknown", message: "unknown" } };
        }
      }),
    },
    DOCS_WARM_PUBLISH_QUEUE: {
      send: async (body: DocsWarmMessage) => void publishQueue.push(body),
      sendBatch: async (messages: { body: DocsWarmMessage }[]) =>
        void publishQueue.push(...messages.map((message) => message.body)),
    },
    DOCS_WARM_SWEEP_QUEUE: {
      sendBatch: async (messages: { body: DocsWarmMessage }[]) =>
        void sweepQueue.push(...messages.map((message) => message.body)),
    },
    DOCS_WARM_LOCK: namespace("lock", DocsWarmLock as ObjectClass),
    DOCS_WARM_ANCHOR: namespace("anchor", DocsWarmAnchor as ObjectClass),
    DOCS_REGIONAL_WARMER: namespace("warmer", DocsRegionalWarmer as ObjectClass),
    DOCS_WARM_CONTROL: namespace("control", DocsWarmControl as ObjectClass),
  });

  const deliver = async (body: DocsWarmMessage, attempts = 1) => {
    const outcome: { acked: boolean; retried: number | undefined | null } = { acked: false, retried: null };
    const message: WarmQueueMessage = {
      body,
      attempts,
      ack: () => {
        outcome.acked = true;
      },
      retry: (options) => {
        outcome.retried = options?.delaySeconds;
      },
    };
    await worker.queue({ messages: [message] } as never, world.env as never);
    return outcome;
  };

  const runAlarms = async (kind: "warmer" | "lock") => {
    for (const [key, instance] of instances) {
      if (!key.startsWith(`${kind}/`)) continue;
      if (storages.get(key)?.alarm === null) continue;
      if (instance instanceof DocsRegionalWarmer || instance instanceof DocsWarmLock) {
        await instance.alarm();
      }
    }
  };

  return { world, kv, publishQueue, sweepQueue, instances, deliver, runAlarms };
}

describe("regional warm job, end to end", () => {
  test("a publish warms every pool and writes the warm state", async () => {
    const flow = createFlow();
    const host = new DocsHostCache({ props: { hostname: "x" } } as never, flow.world.env as never);
    await host.syncHostnames({
      updates: [{ hostname: resolution.hostname, resolvedAt: Date.now(), resolution }],
      warm: { regions: ["oceania"], paths: ["/guide"] },
    });
    expect(flow.publishQueue).toHaveLength(1);
    const message = flow.publishQueue[0];
    if (!message) throw new Error("No message.");
    expect(message).toMatchObject({ reason: "publish", siteId: "site-1", priority: { regions: ["oceania"] } });

    expect(await flow.deliver(message)).toEqual({ acked: true, retried: null });
    // The consumer filled nothing itself (F44).
    expect(flow.world.calls).toEqual([]);
    expect([...flow.instances.keys()].filter((key) => key.startsWith("warmer/")).sort()).toEqual(
      WARM_POOLS.map((pool) => `warmer/warm:${pool}:site-1`).sort(),
    );

    await flow.runAlarms("warmer");
    // 8 pools × 2 pages × (HTML + route data), plus the sample probes.
    const fills = flow.world.calls.filter((call) => !call.probe);
    expect(fills).toHaveLength(32);
    expect(new Set(fills.map((call) => call.url))).toEqual(
      new Set([
        "https://docs.example.com/",
        "https://docs.example.com/guide",
        "https://docs.example.com/_doxa/route-data/v1/",
        "https://docs.example.com/_doxa/route-data/v1/guide",
      ]),
    );

    await flow.runAlarms("lock");
    const record = docsWarmStateSchema.parse(JSON.parse(flow.kv.get(docsWarmStateKey("site-1")) ?? "null"));
    expect(Object.keys(record.pools).sort()).toEqual([...WARM_POOLS].sort());
    expect(record.releaseId).toBe(flow.world.env.DOXA_RENDERER_RELEASE_ID);

    // The fixtures use "site-1"; getWarmStatus takes database UUIDs only (FS-L3).
    const lock = flow.instances.get("lock/site:site-1");
    if (!(lock instanceof DocsWarmLock)) throw new Error("the site lock was not created");
    const status = await lock.getStatus({ siteId: "site-1" });
    expect(status.pools.every((pool) => pool.state === "done")).toBe(true);

    flow.world.calls.length = 0;
    await worker.fetch(
      visitorRequest("https://docs.example.com/guide", { headers: { accept: "text/html" } }),
      flow.world.env as never,
      flow.world.ctx as never,
    );
    expect(flow.world.calls.map((call) => call.status)).toEqual(["HIT"]);
  });

  test("a second message for the same target while the job runs is a duplicate", async () => {
    const flow = createFlow();
    const first = { v: 1, reason: "deploy", siteId: "site-1", hostnames: [resolution.hostname], releaseId: flow.world.env.DOXA_RENDERER_RELEASE_ID, jobId: "00000000-0000-4000-8000-000000000001", enqueuedAt: 1 } as DocsWarmMessage;
    flow.kv.set("host:docs.example.com", JSON.stringify({ format: 1, resolvedAt: Date.now(), resolution }));
    expect((await flow.deliver(first)).acked).toBe(true);
    const second = { ...first, reason: "publish", jobId: "00000000-0000-4000-8000-000000000002", enqueuedAt: 2 } as DocsWarmMessage;
    expect((await flow.deliver(second)).acked).toBe(true);
    // Same target (same hostnames, version and release): a duplicate.
    expect(flow.publishQueue).toEqual([]);
  });

  test("the warm job off: messages are acked and dropped", async () => {
    const flow = createFlow({ DOXA_PROD_WARM_MODE: "off" });
    const outcome = await flow.deliver({
      v: 1,
      reason: "deploy",
      siteId: "site-1",
      hostnames: [resolution.hostname],
      releaseId: String(flow.world.env.DOXA_RENDERER_RELEASE_ID),
      jobId: "00000000-0000-4000-8000-000000000001",
      enqueuedAt: 1,
    });
    expect(outcome).toEqual({ acked: true, retried: null });
    expect(flow.instances.size).toBe(0);
  });

  test("the cron drives the sweep only when it is on", async () => {
    const off = createFlow();
    await worker.scheduled({} as never, off.world.env as never);
    expect(off.instances.size).toBe(0);

    const on = createFlow({ DOXA_PROD_WARM_DEPLOY_SWEEP: "on" });
    on.kv.set("host:docs.example.com", JSON.stringify({ format: 1, resolvedAt: Date.now(), resolution }));
    await worker.scheduled({} as never, on.world.env as never);
    expect(on.sweepQueue).toEqual([
      expect.objectContaining({ reason: "deploy", siteId: "site-1", hostnames: ["docs.example.com"] }),
    ]);
    await worker.scheduled({} as never, on.world.env as never);
    expect(on.sweepQueue).toHaveLength(1);
  });

  test("an invalid body is acked; a thrown consumer error is retried", async () => {
    const flow = createFlow();
    const invalid: WarmQueueMessage = { body: { nope: true }, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await worker.queue({ messages: [invalid] } as never, flow.world.env as never);
    expect(invalid.ack).toHaveBeenCalled();

    Object.assign(flow.world.env, {
      DOCS_RUNTIME: { request: async () => Promise.reject(new Error("runtime down")) },
    });
    flow.kv.set("host:docs.example.com", JSON.stringify({ format: 1, resolvedAt: Date.now(), resolution }));
    const failing: WarmQueueMessage = {
      body: {
        v: 1,
        reason: "deploy",
        siteId: "site-1",
        hostnames: [resolution.hostname],
        releaseId: flow.world.env.DOXA_RENDERER_RELEASE_ID,
        jobId: "00000000-0000-4000-8000-000000000003",
        enqueuedAt: 1,
      },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await worker.queue({ messages: [failing] } as never, flow.world.env as never);
    expect(failing.retry).toHaveBeenCalled();
    expect(failing.ack).not.toHaveBeenCalled();
  });
});
