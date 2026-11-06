import {
  GENERATION_STATE_SCHEMA_VERSION,
  MAX_INSTRUCTION_CATCH_UP_ATTEMPTS,
  exhaustedCatchUpPageIds,
  instructionCatchUpLedgerKey,
  parseInstructionCatchUpLedger,
  type GenerationPageState,
} from "@doxahq/contracts";
import { describe, expect, test } from "vitest";

import {
  assertPageFailureBudget,
  type FailedGenerationPage,
} from "../src/generation-page-failures";
import {
  InstructionCatchUpLedgerConflictError,
  InstructionCatchUpLedgerUnavailableError,
  behindInstructionPageIds,
  failuresUnderBudget,
  publishedBehindPageIds,
  readInstructionCatchUpLedger,
  readInstructionCatchUpLedgerObject,
  recordInstructionCatchUp,
} from "../src/instruction-catch-up";

const hash = "a".repeat(64);

function statePage(
  pageId: string,
  overrides: Partial<GenerationPageState> = {},
): GenerationPageState {
  return {
    schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
    pageId,
    title: pageId,
    route: `/${pageId}`,
    navigationPath: `default/${pageId}.md`,
    artifactKey: `sites/site-1/versions/version-1/source/${pageId}/index.mdx`,
    contentHash: hash,
    pageInputHash: hash,
    dependencies: {
      sourceFilesRead: [],
      sourceFilesDiscovered: [],
      sourceEvidenceFiles: [],
      referencedSymbols: [],
      referencedRoutes: [],
    },
    ...overrides,
  };
}

function failed(id: string): FailedGenerationPage {
  return { id, title: id, reason: "The writer failed." };
}

describe("page failure budget with catch-up pages", () => {
  test("a run whose only pages catch up with the instructions never fails on them", () => {
    const budgeted = failuresUnderBudget({
      failedPages: [failed("guide")],
      regeneratePageIds: ["guide"],
      catchUpPageIds: ["guide"],
    });

    expect(budgeted).toEqual({ failedPages: [], plannedCount: 0 });
    expect(() => assertPageFailureBudget(budgeted.failedPages, budgeted.plannedCount)).not.toThrow();
  });

  test("catch-up failures do not push a run with real work over the budget", () => {
    const budgeted = failuresUnderBudget({
      failedPages: [failed("a"), failed("b"), failed("c")],
      regeneratePageIds: ["a", "b", "c", "real"],
      catchUpPageIds: ["a", "b", "c"],
    });

    expect(budgeted).toEqual({ failedPages: [], plannedCount: 1 });
  });

  test("failures of the pages the run had to write still count", () => {
    const budgeted = failuresUnderBudget({
      failedPages: [failed("real")],
      regeneratePageIds: ["real", "guide"],
      catchUpPageIds: ["guide"],
    });

    expect(() => assertPageFailureBudget(budgeted.failedPages, budgeted.plannedCount)).toThrow();
  });
});

describe("a run where the instructions changed", () => {
  test("has no catch-up pages, so every failure counts toward the budget", () => {
    const budgeted = failuresUnderBudget({
      failedPages: [failed("b"), failed("c"), failed("d"), failed("e")],
      regeneratePageIds: ["a", "b", "c", "d", "e"],
      catchUpPageIds: undefined,
    });

    expect(budgeted).toMatchObject({ plannedCount: 5 });
    expect(budgeted.failedPages).toHaveLength(4);
    expect(() => assertPageFailureBudget(budgeted.failedPages, budgeted.plannedCount)).toThrow();
  });
});

describe("pages behind the instructions", () => {
  test("lists pages a later run writes again, without locked or legacy pages", () => {
    const pageStates = [
      statePage("current", { projectInstructionsFingerprint: "new" }),
      statePage("behind-b", { projectInstructionsFingerprint: "old" }),
      statePage("behind-a", { projectInstructionsFingerprint: "old" }),
      statePage("locked", { projectInstructionsFingerprint: "old" }),
      statePage("legacy"),
    ];

    expect(behindInstructionPageIds({
      pageStates,
      runFingerprint: "new",
      lockedHrefs: new Set(["/locked"]),
      exhaustedPageIds: new Set(),
    })).toEqual(["behind-a", "behind-b"]);
  });

  test("leaves out exhausted pages before the bound, so they cannot fill the list", () => {
    const exhausted = Array.from({ length: 1_000 }, (_, index) => `a-${String(index).padStart(4, "0")}`);
    const pageStates = [...exhausted, "z-workable"].map((pageId) =>
      statePage(pageId, { projectInstructionsFingerprint: "old" })
    );

    expect(behindInstructionPageIds({
      pageStates,
      runFingerprint: "new",
      lockedHrefs: new Set(),
      exhaustedPageIds: new Set(exhausted),
    })).toEqual(["z-workable"]);
  });

  test("the published behind pages are the ones the new structure still has", () => {
    expect(publishedBehindPageIds({
      previousPages: [
        statePage("behind", { projectInstructionsFingerprint: "old" }),
        statePage("removed", { projectInstructionsFingerprint: "old" }),
        statePage("current", { projectInstructionsFingerprint: "run" }),
        statePage("legacy"),
      ],
      previousRunFingerprint: "run",
      currentPageIds: ["behind", "current", "legacy"],
    })).toEqual(["behind"]);
  });
});

interface StoredObject {
  value: string;
  etag: string;
}

/** An R2 stand-in with etags and conditional puts, like `onlyIf` on R2. */
function memoryBucket(initial: Record<string, string> = {}) {
  let version = 0;
  const nextEtag = () => `etag-${++version}`;
  const objects = new Map<string, StoredObject>(
    Object.entries(initial).map(([key, value]) => [key, { value, etag: nextEtag() }]),
  );
  const puts: string[] = [];
  const hooks: { beforePut?: () => void; failGet?: boolean } = {};
  const bucket: Pick<R2Bucket, "get" | "put"> = {
    get: async (key: string) => {
      if (hooks.failGet) throw new Error("R2 is unavailable");
      const stored = objects.get(key);
      return stored === undefined ? null : objectBody(stored);
    },
    put: async (key: string, value: unknown, options?: R2PutOptions) => {
      hooks.beforePut?.();
      const stored = objects.get(key);
      if (!conditionHolds(stored, options?.onlyIf)) return null;
      const written = { value: String(value), etag: nextEtag() };
      objects.set(key, written);
      puts.push(key);
      return objectBody(written);
    },
  } as Pick<R2Bucket, "get" | "put">;
  return {
    hooks,
    puts,
    bucket,
    text: (key: string) => objects.get(key)?.value,
    set: (key: string, value: string) => objects.set(key, { value, etag: nextEtag() }),
  };
}

function conditionHolds(stored: StoredObject | undefined, onlyIf: R2PutOptions["onlyIf"]): boolean {
  if (!onlyIf || onlyIf instanceof Headers) return true;
  if (onlyIf.etagDoesNotMatch === "*") return stored === undefined;
  if (onlyIf.etagMatches !== undefined) return stored?.etag === onlyIf.etagMatches;
  return true;
}

function objectBody(stored: StoredObject): R2ObjectBody {
  return { etag: stored.etag, text: async () => stored.value } as R2ObjectBody;
}

describe("the catch-up ledger", () => {
  const key = instructionCatchUpLedgerKey("site-1");
  const ledgerIn = (store: ReturnType<typeof memoryBucket>) =>
    parseInstructionCatchUpLedger(JSON.parse(store.text(key) ?? "null"));
  const storedLedger = (attempts: Record<string, number>, instructionsFingerprint = "fingerprint-b") =>
    JSON.stringify({ schemaVersion: 1, instructionsFingerprint, lastJobId: "job-9", attempts });

  function run(
    store: ReturnType<typeof memoryBucket>,
    overrides: Partial<Parameters<typeof recordInstructionCatchUp>[0]> = {},
  ) {
    return recordInstructionCatchUp({
      bucket: store.bucket,
      siteId: "site-1",
      jobId: "job-1",
      runFingerprint: "fingerprint-b",
      writeLedger: true,
      catchUpPageIds: ["guide"],
      failedPageIds: new Set(["guide"]),
      behindPageIds: new Set(["guide"]),
      ...overrides,
    });
  }

  test("counts a failed catch-up although the run publishes nothing, and stops trying after the limit", async () => {
    const store = memoryBucket();

    for (let attempt = 1; attempt < MAX_INSTRUCTION_CATCH_UP_ATTEMPTS; attempt++) {
      await expect(run(store, { jobId: `job-${attempt}` })).resolves.toEqual([]);
    }
    await expect(run(store, { jobId: "job-last" })).resolves.toEqual(["guide"]);

    expect(ledgerIn(store)?.attempts).toEqual({ guide: MAX_INSTRUCTION_CATCH_UP_ATTEMPTS });
    expect([...exhaustedCatchUpPageIds(ledgerIn(store), "fingerprint-b")]).toEqual(["guide"]);
  });

  test("does not count a retried step of the same job twice", async () => {
    const store = memoryBucket();

    await run(store);
    await run(store);

    expect(ledgerIn(store)?.attempts).toEqual({ guide: 1 });
  });

  test("a written page keeps its count until its version is published", async () => {
    const store = memoryBucket({ [key]: storedLedger({ guide: 2 }) });

    await run(store, { jobId: "job-2", failedPageIds: new Set() });

    expect(ledgerIn(store)?.attempts).toEqual({ guide: 2 });
  });

  test("drops pages that are no longer behind in the published state or no longer in the structure", async () => {
    const store = memoryBucket({ [key]: storedLedger({ guide: 2, published: 1, removed: 3 }) });

    await run(store, { jobId: "job-2", behindPageIds: new Set(["guide"]) });

    expect(ledgerIn(store)?.attempts).toEqual({ guide: 3 });
  });

  test("gives every page new attempts when the instructions change again", async () => {
    const store = memoryBucket({ [key]: storedLedger({ guide: MAX_INSTRUCTION_CATCH_UP_ATTEMPTS }) });

    await expect(run(store, { runFingerprint: "fingerprint-c", jobId: "job-10" })).resolves.toEqual([]);
    expect(ledgerIn(store)).toMatchObject({ instructionsFingerprint: "fingerprint-c", attempts: { guide: 1 } });
  });

  test("a run with new instructions and no catch-up starts the ledger again, so A to B to A starts from zero", async () => {
    const store = memoryBucket({ [key]: storedLedger({ guide: MAX_INSTRUCTION_CATCH_UP_ATTEMPTS }, "fingerprint-a") });

    await run(store, { runFingerprint: "fingerprint-b", catchUpPageIds: [], failedPageIds: new Set() });
    expect(ledgerIn(store)).toMatchObject({ instructionsFingerprint: "fingerprint-b", attempts: {} });

    await expect(run(store, { runFingerprint: "fingerprint-a", jobId: "job-2", failedPageIds: new Set() }))
      .resolves.toEqual([]);
    expect([...exhaustedCatchUpPageIds(ledgerIn(store), "fingerprint-a")]).toEqual([]);
  });

  test("a preview reads the ledger but never writes it", async () => {
    const store = memoryBucket();

    await run(store, { writeLedger: false });

    expect(store.puts).toEqual([]);
  });

  test("a malformed ledger counts as empty and is replaced", async () => {
    const store = memoryBucket({ [key]: "{not json" });

    await expect(readInstructionCatchUpLedger(store.bucket, "site-1")).resolves.toBeNull();
    await expect(readInstructionCatchUpLedgerObject(store.bucket, "site-1"))
      .resolves.toMatchObject({ status: "malformed" });
    await expect(run(store)).resolves.toEqual([]);
    expect(ledgerIn(store)?.attempts).toEqual({ guide: 1 });
  });

  test("a failed read never writes, so it cannot erase counts it did not see", async () => {
    const store = memoryBucket({ [key]: storedLedger({ guide: 2, other: 3 }) });
    store.hooks.failGet = true;

    await expect(run(store, { jobId: "job-2" })).rejects.toBeInstanceOf(InstructionCatchUpLedgerUnavailableError);
    await expect(readInstructionCatchUpLedger(store.bucket, "site-1")).resolves.toBeNull();
    expect(store.puts).toEqual([]);
    store.hooks.failGet = false;
    expect(ledgerIn(store)?.attempts).toEqual({ guide: 2, other: 3 });
  });

  test("applies the update again to a ledger that another writer changed", async () => {
    const store = memoryBucket({ [key]: storedLedger({ guide: 1 }) });
    let conflicts = 1;
    store.hooks.beforePut = () => {
      if (conflicts-- > 0) store.set(key, storedLedger({ guide: 1, other: 2 }));
    };

    await run(store, { jobId: "job-2", behindPageIds: new Set(["guide", "other"]) });

    expect(ledgerIn(store)?.attempts).toEqual({ guide: 2, other: 2 });
  });

  test("gives up without writing when the ledger keeps changing", async () => {
    const store = memoryBucket({ [key]: storedLedger({ guide: 1 }) });
    store.hooks.beforePut = () => store.set(key, storedLedger({ other: 2 }));

    await expect(run(store, { jobId: "job-2" })).rejects.toBeInstanceOf(InstructionCatchUpLedgerConflictError);
    expect(store.puts).toEqual([]);
  });

  test("does not count twice when the re-read finds this job's own write", async () => {
    const store = memoryBucket();
    store.hooks.beforePut = () => {
      store.hooks.beforePut = undefined;
      store.set(key, JSON.stringify({
        schemaVersion: 1,
        instructionsFingerprint: "fingerprint-b",
        lastJobId: "job-1",
        attempts: { guide: 1 },
      }));
    };

    await run(store);

    expect(ledgerIn(store)?.attempts).toEqual({ guide: 1 });
  });

  test("writes nothing when a run changes nothing", async () => {
    const store = memoryBucket();

    await run(store, { catchUpPageIds: [], failedPageIds: new Set() });

    expect(store.puts).toEqual([]);
  });
});
