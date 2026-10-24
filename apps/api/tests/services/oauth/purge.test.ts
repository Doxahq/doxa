import { describe, expect, it, vi } from "vitest";
import type { PurgeOptions, PurgeResult } from "@cloudflare/workers-oauth-provider";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const { KvPurgeCursorStore, OAuthDataPurge, PURGE_CURSOR_KEY } = await import(
  "../../../src/services/oauth/purge"
);
const { createMemoryKv } = await import("./memory-kv");

const counts = { grantsChecked: 1, grantsPurged: 0, tokensChecked: 1, tokensPurged: 0 };

function setup(results: Array<PurgeResult | Error>) {
  const { kv, entries } = createMemoryKv();
  const purge = vi.fn(async (_options: PurgeOptions) => {
    const next = results.shift();
    if (next === undefined || next instanceof Error) throw next ?? new Error("no result");
    return next;
  });
  const job = new OAuthDataPurge({ purge, cursors: new KvPurgeCursorStore(kv), batchSize: 50 });
  return { job, purge, entries };
}

describe("OAuthDataPurge", () => {
  it("saves the cursor between runs and clears it when the sweep is done", async () => {
    const { job, purge, entries } = setup([
      { ...counts, done: false, cursor: "c-1" },
      { ...counts, done: true },
    ]);

    await job.run();
    expect(entries.get(PURGE_CURSOR_KEY)?.value).toBe("c-1");

    await job.run();
    expect(purge).toHaveBeenNthCalledWith(1, { batchSize: 50 });
    expect(purge).toHaveBeenNthCalledWith(2, { batchSize: 50, cursor: "c-1" });
    expect(entries.has(PURGE_CURSOR_KEY)).toBe(false);
  });

  it("drops a cursor that makes the purge fail, so the next run starts over", async () => {
    const { job, entries } = setup([
      { ...counts, done: false, cursor: "stale" },
      new Error("bad cursor"),
    ]);

    await job.run();
    await expect(job.run()).rejects.toThrow("bad cursor");

    expect(entries.has(PURGE_CURSOR_KEY)).toBe(false);
  });
});
