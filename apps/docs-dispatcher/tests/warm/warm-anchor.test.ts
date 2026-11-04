import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", async () => (await import("./fixtures")).cloudflareWorkersMock());

import { DocsWarmAnchor } from "../../src/warm/docs-warm-anchor";
import {
  parseTraceColo,
  placeAnchor,
  readAnchorColo,
  startPoolOnAnchor,
} from "../../src/warm/warm-anchor";
import type { AnchorStartResult, WarmAnchorRpc } from "../../src/warm/warm-env";
import type { WarmJob } from "../../src/warm/warm-job";
import type { WarmNamespace } from "../../src/warm/warm-storage";
import { MemoryStorage, objectState, warmJob } from "./fixtures";

afterEach(() => {
  vi.restoreAllMocks();
});

const TRACE = "fl=1\nh=doxa.page\nip=1.2.3.4\ncolo=SIN\nloc=SG\n";

function namespace<Stub>(create: (name: string, hint: string | undefined) => Stub) {
  const gets: { name: string; hint: string | undefined }[] = [];
  const ns: WarmNamespace<Stub> = {
    idFromName: (name) => ({ toString: () => name, name, equals: () => false }) as never,
    get: (id, options) => {
      const name = id.toString();
      gets.push({ name, hint: options?.locationHint });
      return create(name, options?.locationHint);
    },
  };
  return { ns, gets };
}

describe("anchor placement (F42)", () => {
  test("reads the colo from a trace body", () => {
    expect(parseTraceColo(TRACE)).toBe("SIN");
    expect(parseTraceColo("colo=sin")).toBeNull();
    expect(parseTraceColo("")).toBeNull();
  });

  test.each<[string, string | null, string]>([
    ["singapore", "SIN", "placed"],
    ["singapore", "HKG", "misplaced"],
    ["hong-kong", "SIN", "misplaced"],
    ["asia-ne", "NRT", "placed"],
    ["singapore", "BOM", "unverified"],
    ["singapore", null, "unverified"],
  ])("pool %s in %s is %s", (pool, colo, placement) => {
    expect(placeAnchor(pool as never, colo)).toBe(placement);
  });

  test("looks the colo up once, on a Doxa-owned host only, and stores it", async () => {
    const storage = new MemoryStorage();
    const fetchText = vi.fn(async (_url: string) => TRACE);
    expect(await readAnchorColo({ storage, baseDomain: "doxa.page", fetchText })).toBe("SIN");
    expect(await readAnchorColo({ storage, baseDomain: "doxa.page", fetchText })).toBe("SIN");
    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(fetchText).toHaveBeenCalledWith("https://doxa.page/cdn-cgi/trace");
  });

  test("no lookup without a valid base domain; a failed lookup is unknown", async () => {
    const fetchText = vi.fn(async () => TRACE);
    expect(
      await readAnchorColo({ storage: new MemoryStorage(), baseDomain: undefined, fetchText }),
    ).toBeNull();
    expect(
      await readAnchorColo({ storage: new MemoryStorage(), baseDomain: "evil.com/x?", fetchText }),
    ).toBeNull();
    expect(fetchText).not.toHaveBeenCalled();
    expect(
      await readAnchorColo({
        storage: new MemoryStorage(),
        baseDomain: "doxa.page",
        fetchText: async () => Promise.reject(new Error("down")),
      }),
    ).toBeNull();
  });
});

describe("starting a pool through its anchors", () => {
  test("uses the pool's location hint and moves on after a misplaced anchor", async () => {
    const { ns, gets } = namespace<WarmAnchorRpc>((name) => ({
      start: async (): Promise<AnchorStartResult> =>
        name === "anchor:singapore" ? { status: "misplaced", colo: "HKG" } : { status: "started", colo: "SIN" },
    }));
    const memo = new Map();
    expect(await startPoolOnAnchor(ns, "singapore", warmJob({ pool: "singapore" }), memo)).toBe(
      "started",
    );
    expect(gets).toEqual([
      { name: "anchor:singapore", hint: "apac-se" },
      { name: "anchor:singapore:2", hint: "apac-se" },
    ]);
    // The next job goes straight to the anchor that worked.
    await startPoolOnAnchor(ns, "singapore", warmJob({ pool: "singapore" }), memo);
    expect(gets.at(-1)).toEqual({ name: "anchor:singapore:2", hint: "apac-se" });
  });

  test("gives up after three misplaced anchors", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { ns, gets } = namespace<WarmAnchorRpc>(() => ({
      start: async (): Promise<AnchorStartResult> => ({ status: "misplaced", colo: "FRA" }),
    }));
    expect(await startPoolOnAnchor(ns, "hong-kong", warmJob({ pool: "hong-kong" }), new Map())).toBe(
      "misplaced",
    );
    expect(gets.map((get) => get.name)).toEqual([
      "anchor:hong-kong",
      "anchor:hong-kong:2",
      "anchor:hong-kong:3",
    ]);
  });
});

describe("DocsWarmAnchor", () => {
  function createAnchor(colo: string) {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(`colo=${colo}\n`));
    const started: WarmJob[] = [];
    const warmers = namespace((name) => ({
      start: async ({ job }: { job: WarmJob }) => {
        started.push(job);
        expect(name).toBe(`warm:${job.pool}:${job.siteId}`);
      },
    }));
    const anchor = new DocsWarmAnchor(
      objectState(new MemoryStorage()) as never,
      { DOXA_DOCS_BASE_DOMAIN: "doxa.page", DOCS_REGIONAL_WARMER: warmers.ns } as never,
    );
    return { anchor, started, warmers };
  }

  test("creates the site's warmer without a hint when it sits in its pool", async () => {
    const { anchor, started, warmers } = createAnchor("CDG");
    expect(await anchor.start({ job: warmJob({ pool: "eu-west" }) })).toEqual({
      status: "started",
      colo: "CDG",
    });
    expect(started).toHaveLength(1);
    expect(warmers.gets).toEqual([{ name: "warm:eu-west:site-1", hint: undefined }]);
    expect(globalThis.fetch).toHaveBeenCalledWith("https://doxa.page/cdn-cgi/trace");
  });

  test("refuses work in another pool and logs anchor_misplaced facts", async () => {
    const { anchor, started } = createAnchor("FRA");
    expect(await anchor.start({ job: warmJob({ pool: "eu-west" }) })).toEqual({
      status: "misplaced",
      colo: "FRA",
    });
    expect(started).toEqual([]);
    const logged = vi
      .mocked(console.info)
      .mock.calls.map((call) => JSON.parse(String(call[0])))
      .find((line) => line.event === "docs_warm_anchor");
    expect(logged).toMatchObject({ pool: "eu-west", colo: "FRA", misplaced: true });
  });

  test("rejects an invalid job", async () => {
    const { anchor } = createAnchor("CDG");
    await expect(anchor.start({ job: { ...warmJob(), pool: "mars" } })).rejects.toThrow();
  });
});
