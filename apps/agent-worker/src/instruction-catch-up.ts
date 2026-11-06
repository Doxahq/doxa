import {
  MAX_BEHIND_INSTRUCTION_PAGE_IDS,
  NO_PROJECT_INSTRUCTIONS_FINGERPRINT,
  exhaustedCatchUpPageIds,
  instructionCatchUpLedgerKey,
  nextInstructionCatchUpLedger,
  parseInstructionCatchUpLedger,
  type GenerationPageState,
  type InstructionCatchUpLedger,
} from "@doxahq/contracts";
import { normalizeHref } from "@doxahq/docs-engine";
import type { FailedGenerationPage } from "./generation-page-failures";

/**
 * The failures that count toward the page failure budget, and the pages they
 * count against. A page that the run writes only to catch up with the
 * instructions counts in neither: its published version stays, and a page
 * that always fails must not stop runs that change something else.
 */
export function failuresUnderBudget(input: {
  failedPages: readonly FailedGenerationPage[];
  regeneratePageIds: readonly string[];
  catchUpPageIds: readonly string[] | undefined;
}): { failedPages: FailedGenerationPage[]; plannedCount: number } {
  const catchUp = new Set(input.catchUpPageIds ?? []);
  return {
    failedPages: input.failedPages.filter((page) => !catchUp.has(page.id)),
    plannedCount: input.regeneratePageIds.filter((pageId) => !catchUp.has(pageId)).length,
  };
}

/**
 * The pages of a new state that stay behind its own instructions, for the
 * manifest: a later run with the same instructions writes them again. Locked
 * pages never catch up, and runs no longer try exhausted pages, so both are
 * left out before the bound, which they could otherwise fill. Sorted.
 */
export function behindInstructionPageIds(input: {
  pageStates: readonly GenerationPageState[];
  runFingerprint: string;
  lockedHrefs: ReadonlySet<string>;
  exhaustedPageIds: ReadonlySet<string>;
}): string[] {
  return input.pageStates
    .filter((page) =>
      page.projectInstructionsFingerprint !== undefined
      && page.projectInstructionsFingerprint !== input.runFingerprint
      && !input.lockedHrefs.has(normalizeHref(page.route))
      && !input.exhaustedPageIds.has(page.pageId)
    )
    .map((page) => page.pageId)
    .sort()
    .slice(0, MAX_BEHIND_INSTRUCTION_PAGE_IDS);
}

type LedgerBucket = Pick<R2Bucket, "get" | "put">;

/** What the stored ledger object holds. The etag guards the next write. */
export type InstructionCatchUpLedgerRead =
  | { status: "missing" }
  | { status: "malformed"; etag: string }
  | { status: "found"; ledger: InstructionCatchUpLedger; etag: string }
  | { status: "unreadable"; error: unknown };

/** The ledger a read gives; anything but a parsed ledger counts as empty. */
export function ledgerOf(read: InstructionCatchUpLedgerRead): InstructionCatchUpLedger | null {
  return read.status === "found" ? read.ledger : null;
}

/** Reads the site's catch-up ledger and tells a missing object from a failed read. */
export async function readInstructionCatchUpLedgerObject(
  bucket: Pick<R2Bucket, "get">,
  siteId: string,
): Promise<InstructionCatchUpLedgerRead> {
  let object: R2ObjectBody | null;
  let text: string;
  try {
    object = await bucket.get(instructionCatchUpLedgerKey(siteId));
    if (!object) return { status: "missing" };
    text = await object.text();
  } catch (error) {
    return { status: "unreadable", error };
  }
  const ledger = parseInstructionCatchUpLedger(parseJson(text));
  return ledger
    ? { status: "found", ledger, etag: object.etag }
    : { status: "malformed", etag: object.etag };
}

/**
 * The site's catch-up ledger for planning. A missing, malformed or
 * unreadable one is empty: at worst a run tries an exhausted page once more.
 */
export async function readInstructionCatchUpLedger(
  bucket: Pick<R2Bucket, "get">,
  siteId: string,
): Promise<InstructionCatchUpLedger | null> {
  return ledgerOf(await readInstructionCatchUpLedgerObject(bucket, siteId));
}

/** The ledger could not be read, so a write would erase counts it cannot see. */
export class InstructionCatchUpLedgerUnavailableError extends Error {
  constructor(readonly readError: unknown) {
    super("The instruction catch-up ledger could not be read, so it was not updated.");
    this.name = "InstructionCatchUpLedgerUnavailableError";
  }
}

/** Another writer changed the ledger twice while this run tried to update it. */
export class InstructionCatchUpLedgerConflictError extends Error {
  constructor() {
    super("The instruction catch-up ledger changed during the update, so it was not updated.");
    this.name = "InstructionCatchUpLedgerConflictError";
  }
}

/** One re-read after a conflicting write; a second conflict gives up. */
const LEDGER_WRITE_ATTEMPTS = 2;

/**
 * Counts this run's catch-up results in the site's ledger and returns the
 * pages that runs no longer try under the run's instructions. Only a
 * production run writes, published or not, because the next production run
 * plans from it. A preview reads it only. A write is conditional on the
 * object it read, so a concurrent writer is never overwritten: on a conflict
 * the update is applied again to the new object. A failed read never writes.
 */
export async function recordInstructionCatchUp(input: {
  bucket: LedgerBucket;
  siteId: string;
  jobId: string;
  runFingerprint: string;
  writeLedger: boolean;
  catchUpPageIds: readonly string[];
  failedPageIds: ReadonlySet<string>;
  behindPageIds: ReadonlySet<string>;
}): Promise<string[]> {
  for (let attempt = 1; attempt <= LEDGER_WRITE_ATTEMPTS; attempt++) {
    const read = await readInstructionCatchUpLedgerObject(input.bucket, input.siteId);
    if (read.status === "unreadable") {
      if (!input.writeLedger) return [];
      throw new InstructionCatchUpLedgerUnavailableError(read.error);
    }
    const ledger = ledgerOf(read);
    const next = input.writeLedger
      ? nextInstructionCatchUpLedger({
        ledger,
        instructionsFingerprint: input.runFingerprint,
        jobId: input.jobId,
        catchUpPageIds: input.catchUpPageIds,
        failedPageIds: input.failedPageIds,
        behindPageIds: input.behindPageIds,
      })
      : null;
    if (!next) return exhaustedPageIdsOf(ledger, input.runFingerprint);

    const written = await input.bucket.put(instructionCatchUpLedgerKey(input.siteId), JSON.stringify(next), {
      onlyIf: read.status === "missing" ? { etagDoesNotMatch: "*" } : { etagMatches: read.etag },
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    if (written) return exhaustedPageIdsOf(next, input.runFingerprint);
  }
  throw new InstructionCatchUpLedgerConflictError();
}

function exhaustedPageIdsOf(ledger: InstructionCatchUpLedger | null, runFingerprint: string): string[] {
  return [...exhaustedCatchUpPageIds(ledger, runFingerprint)].sort();
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The pages behind the instructions in the published state that this run's
 * structure still has: the only pages whose ledger entries stay. A page is
 * behind when its own fingerprint differs from its state's run fingerprint.
 */
export function publishedBehindPageIds(input: {
  previousPages: readonly GenerationPageState[];
  previousRunFingerprint: string | undefined;
  currentPageIds: readonly string[];
}): string[] {
  const current = new Set(input.currentPageIds);
  const runFingerprint = input.previousRunFingerprint ?? NO_PROJECT_INSTRUCTIONS_FINGERPRINT;
  return input.previousPages
    .filter((page) =>
      current.has(page.pageId)
      && (page.projectInstructionsFingerprint ?? runFingerprint) !== runFingerprint
    )
    .map((page) => page.pageId)
    .sort();
}
