import { describe, expect, test } from "vitest";

import { AGENT_ASSET_UPLOAD_LIMITS, DOCS_ASSET_LIMITS } from "@doxahq/contracts/docs-assets";
import type { AgentAssetUploadResource } from "@doxahq/contracts/storage-gc";
import {
  agentUploadOwnerKeys,
  type AgentConnection,
} from "../../src/services/docs-branches/assets/agent-asset-upload-keys";
import {
  AgentAssetUploads,
  type AgentAssetUploadRecord,
  type BodyReadOutcome,
} from "../../src/services/docs-branches/assets/agent-asset-uploads";
import {
  createR2AgentUploadStore,
  type AgentUploadStore,
} from "../../src/services/docs-branches/assets/agent-upload-store";
import { DocsContentError } from "../../src/services/docs-content/errors";
import { createR2DocsObjectStore } from "../../src/services/docs-content/store";
import { createAgentAssetUploadCollector } from "../../src/services/storage-gc";
import { createMemoryR2Bucket } from "../support/memory-r2-bucket";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";
const BRANCH = "55555555-5555-4555-8555-555555555555";
const AGENT: AgentConnection = { userId: "owner", clientId: "client" };
const TTL_MS = AGENT_ASSET_UPLOAD_LIMITS.ttlSeconds * 1000;
const PER_CONNECTION = AGENT_ASSET_UPLOAD_LIMITS.maxOpenPerConnection;
const PER_MEMBER = AGENT_ASSET_UPLOAD_LIMITS.maxOpenPerMember;

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...new Array<number>(24).fill(0)]);
/** A Windows executable header: the PUT must never store it. */
const EXE = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04]);

/** Changes the store of a test, for example to make every swap lose. */
type StoreWrapper = (store: AgentUploadStore) => AgentUploadStore;

function setup(wrapStore: StoreWrapper = (store) => store) {
  const memory = createMemoryR2Bucket();
  const registered: AgentAssetUploadResource[] = [];
  let now = new Date("2026-11-07T10:00:00.000Z");
  const uploads = new AgentAssetUploads({
    store: wrapStore(createR2AgentUploadStore(memory.bucket)),
    registerUpload: async (resource) => void registered.push(resource),
    now: () => now,
  });
  return {
    memory,
    uploads,
    registered,
    collector: createAgentAssetUploadCollector({ objects: createR2DocsObjectStore(memory.bucket) }),
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    keys: () => [...memory.objects.keys()].sort(),
  };
}

function create(uploads: AgentAssetUploads, agent: AgentConnection = AGENT) {
  return uploads.create({ ownerUserId: "owner", projectId: PROJECT, branchId: BRANCH, agent, fileName: "a.png" });
}

const body = (bytes: Uint8Array) => async (): Promise<BodyReadOutcome> => ({ kind: "body", bytes });
const owner = { projectId: PROJECT, agent: AGENT };

async function ticketOf(uploads: AgentAssetUploads, uploadId: string): Promise<AgentAssetUploadRecord> {
  const taken = await uploads.takeFor(uploadId, owner);
  if (taken.kind === "not_found") throw new Error("No ticket.");
  return taken.ticket;
}

async function rejection(promise: Promise<unknown>): Promise<DocsContentError> {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  if (!(error instanceof DocsContentError)) throw new Error("Expected a DocsContentError.");
  return error;
}

async function ledgerOf(memory: ReturnType<typeof createMemoryR2Bucket>, agent = AGENT) {
  const { memberKey } = await agentUploadOwnerKeys(agent);
  const text = memory.text(`agent-upload-ledgers/${memberKey}.json`);
  return text === null ? null : (JSON.parse(text) as { open: Array<{ uploadId: string }> });
}

/** The outcome of each call, in order, without throwing. */
function settle<T>(calls: ReadonlyArray<Promise<T>>) {
  return Promise.all(
    calls.map((call) =>
      call.then(
        () => "created" as const,
        (error: unknown) => (error instanceof DocsContentError ? error.code : "other"),
      ),
    ),
  );
}

const countOf = (outcomes: readonly string[], outcome: string) =>
  outcomes.filter((each) => each === outcome).length;

/**
 * A store whose reads wait a moment before they answer. Parallel claims then
 * all read the ledger before any of them writes it: the real race.
 */
const slowReads: StoreWrapper = (store) => ({
  ...store,
  async readVersioned(key) {
    const stored = await store.readVersioned(key);
    await new Promise((resolve) => setTimeout(resolve, 2));
    return stored;
  },
});

/** A store whose compare-and-swap writes always lose to "another request". */
const swapsAlwaysLose: StoreWrapper = (store) => ({
  ...store,
  replaceIfUnchanged: async () => false,
  createIfAbsent: async () => false,
});

describe("receiving a file", () => {
  test("stores an image once, then hands it to its owner", async () => {
    const { uploads } = setup();
    const created = await create(uploads);

    expect(await uploads.receive(created.uploadId, created.secret, body(PNG))).toEqual({ ok: true, size: PNG.byteLength });
    expect(await uploads.receive(created.uploadId, created.secret, body(PNG))).toEqual({ ok: false, reason: "already_received" });
    const taken = await uploads.takeFor(created.uploadId, owner);
    expect(taken.kind).toBe("ready");
    if (taken.kind === "ready") expect(taken.bytes).toEqual(PNG);
  });

  test("never stores a file that is not an image", async () => {
    const { uploads, memory } = setup();
    const created = await create(uploads);

    expect(await uploads.receive(created.uploadId, created.secret, body(EXE))).toEqual({ ok: false, reason: "not_an_image" });
    expect(memory.objects.has(`agent-uploads/${created.uploadId}/file`)).toBe(false);
    // The URL still takes an image after a refusal.
    expect((await uploads.receive(created.uploadId, created.secret, body(PNG))).ok).toBe(true);
  });

  test("lets only one of two parallel PUTs store a file", async () => {
    const { uploads, memory } = setup();
    const created = await create(uploads);
    const other = Uint8Array.from([...PNG, 1]);

    const results = await Promise.all([
      uploads.receive(created.uploadId, created.secret, body(PNG)),
      uploads.receive(created.uploadId, created.secret, body(other)),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "conflict" }]);
    const winner = results[0]?.ok ? PNG : other;
    expect(memory.objects.get(`agent-uploads/${created.uploadId}/file`)?.bytes).toEqual(winner);
  });

  test(`closes the URL after ${AGENT_ASSET_UPLOAD_LIMITS.maxFailedAttempts} refused PUTs`, async () => {
    const { uploads } = setup();
    const created = await create(uploads);
    const failures: Array<() => Promise<BodyReadOutcome>> = [
      body(EXE),
      async () => ({ kind: "too_large" }),
      async () => ({ kind: "timed_out" }),
      body(new Uint8Array()),
      body(EXE),
    ];
    const reasons = [];
    for (const failure of failures) {
      const result = await uploads.receive(created.uploadId, created.secret, failure);
      reasons.push(result.ok ? "ok" : result.reason);
    }
    expect(reasons).toEqual(["not_an_image", "too_large", "timed_out", "empty", "not_an_image"]);

    let read = false;
    const closed = await uploads.receive(created.uploadId, created.secret, async () => {
      read = true;
      return { kind: "body", bytes: PNG };
    });
    expect(closed).toEqual({ ok: false, reason: "closed" });
    expect(read).toBe(false);
  });

  test("never stores a body that finished after the expiry", async () => {
    const { uploads, memory, advance } = setup();
    const created = await create(uploads);
    const result = await uploads.receive(created.uploadId, created.secret, async () => {
      advance(TTL_MS);
      return { kind: "body", bytes: PNG };
    });
    expect(result).toEqual({ ok: false, reason: "expired" });
    expect(memory.objects.has(`agent-uploads/${created.uploadId}/file`)).toBe(false);
  });

  test("treats a wrong secret like an unknown upload and never reads the body", async () => {
    const { uploads } = setup();
    const created = await create(uploads);
    const forged = `${created.secret.startsWith("A") ? "B" : "A"}${created.secret.slice(1)}`;
    let read = false;
    const result = await uploads.receive(created.uploadId, forged, async () => {
      read = true;
      return { kind: "body", bytes: PNG };
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(read).toBe(false);
  });

  test("refuses a secret of the wrong shape before any storage read", async () => {
    const { uploads, memory } = setup();
    const created = await create(uploads);
    memory.resetCalls();
    for (const secret of ["", "short", `${"A".repeat(43)}=`, "../../ticket.json".padEnd(43, "A")]) {
      expect(await uploads.receive(created.uploadId, secret, body(PNG))).toEqual({ ok: false, reason: "not_found" });
    }
    expect(memory.calls.get).toEqual([]);
  });

  test("expires with the URL", async () => {
    const { uploads, advance } = setup();
    const created = await create(uploads);
    advance(TTL_MS);
    expect(await uploads.receive(created.uploadId, created.secret, body(PNG))).toEqual({ ok: false, reason: "expired" });
    expect(await uploads.takeFor(created.uploadId, owner)).toEqual({ kind: "not_found" });
  });

  test(`accepts exactly ${DOCS_ASSET_LIMITS.maxBytes} bytes and asks the reader for no more`, async () => {
    const { uploads } = setup();
    const created = await create(uploads);
    let asked = 0;
    const exact = new Uint8Array(DOCS_ASSET_LIMITS.maxBytes);
    exact.set(PNG);
    const result = await uploads.receive(created.uploadId, created.secret, async (maxBytes) => {
      asked = maxBytes;
      return { kind: "body", bytes: exact };
    });
    expect(asked).toBe(DOCS_ASSET_LIMITS.maxBytes);
    expect(result).toEqual({ ok: true, size: DOCS_ASSET_LIMITS.maxBytes });
  });
});

describe("taking a file", () => {
  test("answers not_found to another project or connection before reading bytes", async () => {
    const { uploads, memory } = setup();
    const created = await create(uploads);
    await uploads.receive(created.uploadId, created.secret, body(PNG));
    memory.resetCalls();

    for (const stranger of [
      { projectId: OTHER_PROJECT, agent: AGENT },
      { projectId: PROJECT, agent: { userId: "owner", clientId: "other-client" } },
      { projectId: PROJECT, agent: { userId: "teammate", clientId: "client" } },
    ]) {
      expect(await uploads.takeFor(created.uploadId, stranger)).toEqual({ kind: "not_found" });
    }
    expect(memory.calls.get).toEqual([
      `agent-uploads/${created.uploadId}/ticket.json`,
      `agent-uploads/${created.uploadId}/ticket.json`,
      `agent-uploads/${created.uploadId}/ticket.json`,
    ]);
  });

  test("reports an open URL as not sent", async () => {
    const { uploads } = setup();
    const created = await create(uploads);
    expect((await uploads.takeFor(created.uploadId, owner)).kind).toBe("not_sent");
  });
});

describe("storage contents", () => {
  test("never writes the secret, and keeps the member and client IDs out of keys and the ledger", async () => {
    const { uploads, memory, keys } = setup();
    const agent = { userId: "member-7", clientId: "client-9" };
    const created = await create(uploads, agent);
    const ticket = memory.text(`agent-uploads/${created.uploadId}/ticket.json`) ?? "";
    expect(ticket).not.toContain(created.secret);
    expect(keys().join("\n")).not.toMatch(/member-7|client-9/);
    const ledger = JSON.stringify(await ledgerOf(memory, agent));
    expect(ledger).toContain(created.uploadId);
    expect(ledger).not.toMatch(/member-7|client-9/);
    expect(ledger).not.toContain(created.secret);
  });

  test("keeps member and connection keys apart even when IDs share separators", async () => {
    const left = await agentUploadOwnerKeys({ userId: "a.b", clientId: "c" });
    const right = await agentUploadOwnerKeys({ userId: "a", clientId: "b.c" });
    expect(left.connectionKey).not.toBe(right.connectionKey);
    expect(left.memberKey).not.toBe(right.memberKey);
  });
});

describe("open upload limits", () => {
  test(`allows ${PER_CONNECTION} open uploads per connection`, async () => {
    const { uploads } = setup();
    for (let index = 0; index < PER_CONNECTION; index++) await create(uploads);

    const error = await rejection(create(uploads));
    expect(error.code).toBe("asset_upload_limit_reached");
    expect(error.details).toEqual({ scope: "connection", maxOpenUploads: PER_CONNECTION, retryAfterSeconds: TTL_MS / 1000 });
  });

  test(`allows ${PER_MEMBER} open uploads per member across connections`, async () => {
    const { uploads } = setup();
    for (let index = 0; index < PER_MEMBER; index++) {
      await create(uploads, { userId: "owner", clientId: `client-${index % 3}` });
    }
    const error = await rejection(create(uploads, { userId: "owner", clientId: "fresh-client" }));
    expect(error.details).toMatchObject({ scope: "member", maxOpenUploads: PER_MEMBER });
    // Another member is not affected.
    await expect(create(uploads, { userId: "teammate", clientId: "client" })).resolves.toBeDefined();
  });

  test("frees a slot when an upload finishes", async () => {
    const { uploads } = setup();
    const created = await Promise.all(Array.from({ length: PER_CONNECTION }, () => create(uploads)));
    await uploads.discard(await ticketOf(uploads, created[0]?.uploadId ?? ""));
    await expect(create(uploads)).resolves.toBeDefined();
  });

  test("frees a slot when an upload expires, and reports when", async () => {
    const { uploads, advance } = setup();
    await create(uploads);
    advance(60_000);
    for (let index = 1; index < PER_CONNECTION; index++) await create(uploads);

    const error = await rejection(create(uploads));
    expect(error.details).toMatchObject({ retryAfterSeconds: TTL_MS / 1000 - 60 });

    advance(TTL_MS - 60_000);
    await expect(create(uploads)).resolves.toBeDefined();
  });

  test("registers nothing when the limit refuses", async () => {
    const { uploads, registered } = setup();
    for (let index = 0; index < PER_CONNECTION; index++) await create(uploads);
    await rejection(create(uploads));
    expect(registered).toHaveLength(PER_CONNECTION);
  });
});

describe("open upload limits under concurrent requests", () => {
  test(`lets exactly ${PER_CONNECTION} of 20 parallel creates on one connection through`, async () => {
    const { uploads, memory, registered } = setup(slowReads);
    const outcomes = await settle(Array.from({ length: 20 }, () => create(uploads)));

    expect(countOf(outcomes, "created")).toBe(PER_CONNECTION);
    expect(countOf(outcomes, "asset_upload_limit_reached")).toBe(20 - PER_CONNECTION);
    expect((await ledgerOf(memory))?.open).toHaveLength(PER_CONNECTION);
    expect(registered).toHaveLength(PER_CONNECTION);
  });

  test(`lets exactly ${PER_MEMBER} of 40 parallel creates across connections through`, async () => {
    const { uploads, memory } = setup(slowReads);
    const outcomes = await settle(
      Array.from({ length: 40 }, (_, index) =>
        create(uploads, { userId: "owner", clientId: `client-${index % 8}` }),
      ),
    );

    expect(countOf(outcomes, "created")).toBe(PER_MEMBER);
    expect(countOf(outcomes, "asset_upload_limit_reached")).toBe(40 - PER_MEMBER);
    expect((await ledgerOf(memory))?.open).toHaveLength(PER_MEMBER);
  });

  test("loses no slot when finishes and creates run at the same moment", async () => {
    const { uploads, memory } = setup(slowReads);
    const first = await Promise.all(Array.from({ length: PER_CONNECTION }, () => create(uploads)));
    const tickets = await Promise.all(first.map((created) => ticketOf(uploads, created.uploadId)));

    const [, outcomes] = await Promise.all([
      Promise.all(tickets.map((ticket) => uploads.discard(ticket))),
      settle(Array.from({ length: PER_CONNECTION }, () => create(uploads))),
    ]);

    // Every create either took a freed slot or saw the limit; none passed it.
    const open = (await ledgerOf(memory))?.open ?? [];
    expect(open).toHaveLength(countOf(outcomes, "created"));
    expect(open.length).toBeLessThanOrEqual(PER_CONNECTION);
    expect(open.some((entry) => first.some((created) => created.uploadId === entry.uploadId))).toBe(false);
  });

  test("refuses with asset_upload_busy when every swap loses, and writes nothing", async () => {
    const { uploads, registered, keys } = setup(swapsAlwaysLose);
    const error = await rejection(create(uploads));
    expect(error.code).toBe("asset_upload_busy");
    expect(registered).toEqual([]);
    expect(keys()).toEqual([]);
  });

  test("keeps the slot taken when a release loses every swap", async () => {
    let swapsLose = false;
    const { uploads, memory } = setup((store) => ({
      ...store,
      replaceIfUnchanged: async (key, text, etag) =>
        swapsLose ? false : store.replaceIfUnchanged(key, text, etag),
    }));
    const created = await create(uploads);
    const ticket = await ticketOf(uploads, created.uploadId);

    swapsLose = true;
    await expect(uploads.discard(ticket)).resolves.toBeUndefined();
    expect((await ledgerOf(memory))?.open.map((entry) => entry.uploadId)).toEqual([created.uploadId]);
    expect(memory.objects.has(`agent-uploads/${created.uploadId}/ticket.json`)).toBe(false);
  });

  test("replaces a ledger that it cannot read", async () => {
    const { uploads, memory } = setup();
    const { memberKey } = await agentUploadOwnerKeys(AGENT);
    await memory.bucket.put(`agent-upload-ledgers/${memberKey}.json`, "{not json");

    const created = await create(uploads);
    expect((await ledgerOf(memory))?.open.map((entry) => entry.uploadId)).toEqual([created.uploadId]);
  });
});

describe("agent_asset_upload collector", () => {
  test("registers the upload before writing its keys", async () => {
    const { uploads, registered } = setup();
    const created = await create(uploads);
    expect(registered).toEqual([{ uploadId: created.uploadId }]);
  });

  test("always collects and deletes only the keys of its upload", async () => {
    const { uploads, collector, registered, keys } = setup();
    const kept = await create(uploads);
    const dropped = await create(uploads);
    await uploads.receive(dropped.uploadId, dropped.secret, body(PNG));

    const resource = collector.parse(registered[1]);
    expect(await collector.inspect(resource)).toEqual({ status: "collect" });
    expect(await collector.collect(resource)).toEqual({ deletedObjects: 2, status: "complete" });

    const uploadKeys = keys().filter((key) => key.startsWith("agent-uploads/"));
    expect(uploadKeys).toEqual([`agent-uploads/${kept.uploadId}/ticket.json`]);
    // The ledger stays: its entry for the collected upload expires on its own.
    expect(keys().filter((key) => key.startsWith("agent-upload-ledgers/"))).toHaveLength(1);
  });

  test("finds nothing after a finished upload", async () => {
    const { uploads, collector, registered } = setup();
    const created = await create(uploads);
    await uploads.discard(await ticketOf(uploads, created.uploadId));
    expect(await collector.collect(collector.parse(registered[0]))).toEqual({ deletedObjects: 0, status: "complete" });
  });

  test("refuses a resource that could name another prefix", () => {
    const { collector } = setup();
    expect(() => collector.parse({ uploadId: "../sites" })).toThrow();
    expect(() => collector.parse({ uploadId: crypto.randomUUID(), extra: 1 })).toThrow();
  });
});
