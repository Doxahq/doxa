import type { DocsWarmMessage } from "@doxahq/contracts/docs-warm-job";
import { describe, expect, test, vi } from "vitest";

import { runSweepTick, type SweepDeps, type SweepListKey } from "../../src/warm/warm-sweep";
import { OTHER_RELEASE, RELEASE, mapEntry, siteResolution } from "./fixtures";

/** A KV namespace listing `keys` in pages of `pageSize`. */
function createKv(keys: SweepListKey[], pageSize: number, values = new Map<string, string>()) {
  const lists: (string | undefined)[] = [];
  const list = vi.fn(async (options: { prefix: string; cursor?: string; limit: number }) => {
    lists.push(options.cursor);
    const start = options.cursor ? Number(options.cursor) : 0;
    const page = keys.filter((key) => key.name.startsWith(options.prefix)).slice(start, start + pageSize);
    const next = start + pageSize;
    return next < keys.length
      ? { keys: page, list_complete: false, cursor: String(next) }
      : { keys: page, list_complete: true };
  });
  return { list, lists, get: vi.fn(async (key: string) => values.get(key) ?? null) };
}

function hostKey(hostname: string, siteId: string | null): SweepListKey {
  return siteId ? { name: `host:${hostname}`, metadata: { siteId } } : { name: `host:${hostname}` };
}

function createDeps(
  kv: ReturnType<typeof createKv>,
  inRollout: (siteId: string) => boolean = () => true,
) {
  const sent: DocsWarmMessage[][] = [];
  let id = 0;
  const deps: SweepDeps = {
    list: kv.list,
    get: kv.get,
    send: vi.fn(async (messages: DocsWarmMessage[]) => {
      sent.push(messages);
    }),
    isWarmSite: inRollout,
    createJobId: () => `00000000-0000-4000-8000-${String((id += 1)).padStart(12, "0")}`,
    now: () => 7_000,
  };
  return { deps, sent };
}

const KEYS = [
  hostKey("a1.example.com", "site-a"),
  hostKey("a2.example.com", "site-a"),
  hostKey("b1.example.com", "site-b"),
  hostKey("c1.example.com", "site-c"),
  hostKey("c2.example.com", "site-c"),
  hostKey("d1.example.com", "site-d"),
];

describe("deploy sweep", () => {
  test("groups keys by metadata site and pages through the list with a cursor", async () => {
    const kv = createKv(KEYS, 4);
    const { deps, sent } = createDeps(kv);
    const first = await runSweepTick(null, { releaseId: RELEASE, cap: 2 }, deps);
    expect(first).toMatchObject({ reset: true, enqueued: 2 });
    expect(sent[0]?.map((m) => [m.siteId, m.hostnames])).toEqual([
      ["site-a", ["a1.example.com", "a2.example.com"]],
      ["site-b", ["b1.example.com"]],
    ]);
    expect(sent[0]?.[0]).toEqual({
      v: 1,
      reason: "deploy",
      siteId: "site-a",
      hostnames: ["a1.example.com", "a2.example.com"],
      releaseId: RELEASE,
      jobId: "00000000-0000-4000-8000-000000000001",
      enqueuedAt: 7_000,
    });
    expect(first.state).toMatchObject({ cursor: null, offset: 3, done: false, enqueued: 2 });

    const second = await runSweepTick(first.state, { releaseId: RELEASE, cap: 2 }, deps);
    expect(sent[1]?.map((m) => [m.siteId, m.hostnames])).toEqual([
      ["site-c", ["c1.example.com", "c2.example.com"]],
      ["site-d", ["d1.example.com"]],
    ]);
    expect(second.state).toMatchObject({ done: true, enqueued: 4 });
    expect(kv.lists).toEqual([undefined, undefined, "4"]);

    // Done stays done until the next release.
    const third = await runSweepTick(second.state, { releaseId: RELEASE, cap: 2 }, deps);
    expect(third.enqueued).toBe(0);
    expect(kv.list).toHaveBeenCalledTimes(3);
  });

  test("a new release restarts from the first key", async () => {
    const kv = createKv(KEYS, 10);
    const { deps } = createDeps(kv);
    const done = (await runSweepTick(null, { releaseId: RELEASE, cap: 100 }, deps)).state;
    expect(done.done).toBe(true);
    const next = await runSweepTick(done, { releaseId: OTHER_RELEASE, cap: 100 }, deps);
    expect(next).toMatchObject({ reset: true, enqueued: 4 });
    expect(next.state.releaseId).toBe(OTHER_RELEASE);
  });

  test("never enqueues more sites than the cap; no free slots means no work", async () => {
    const kv = createKv(KEYS, 10);
    const { deps, sent } = createDeps(kv);
    expect((await runSweepTick(null, { releaseId: RELEASE, cap: 1 }, deps)).enqueued).toBe(1);
    expect(sent.flat()).toHaveLength(1);
    const none = await runSweepTick(null, { releaseId: RELEASE, cap: 0 }, deps);
    expect(none.enqueued).toBe(0);
    expect(kv.list).toHaveBeenCalledTimes(1);
  });

  test("reads the entry when a key has no metadata (F26), and skips sites outside the rollout", async () => {
    const values = new Map([
      ["host:old.example.com", mapEntry(siteResolution({ siteId: "site-old", hostname: "old.example.com" }), 1)],
      ["host:broken.example.com", "{"],
    ]);
    const kv = createKv(
      [hostKey("old.example.com", null), hostKey("broken.example.com", null), hostKey("x.example.com", "site-x")],
      10,
      values,
    );
    const { deps, sent } = createDeps(kv, (siteId) => siteId !== "site-x");
    const result = await runSweepTick(null, { releaseId: RELEASE, cap: 10 }, deps);
    expect(sent.flat().map((m) => [m.siteId, m.hostnames])).toEqual([["site-old", ["old.example.com"]]]);
    expect(kv.get).toHaveBeenCalledTimes(2);
    expect(result.state.done).toBe(true);
  });

  test("a failed send keeps the stored cursor (state is saved by the caller only on success)", async () => {
    const kv = createKv(KEYS, 10);
    const { deps } = createDeps(kv);
    deps.send = async () => Promise.reject(new Error("queue down"));
    await expect(runSweepTick(null, { releaseId: RELEASE, cap: 10 }, deps)).rejects.toThrow("queue down");
  });
});
