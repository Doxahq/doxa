import { pageNoticeSchema, type PageNotice } from "@doxahq/contracts/generation-reviews";
import { z } from "zod";
import type { FailedGenerationPage, PageBatchOutcome } from "./generation-page-failures";
import type { BehindInstructionCandidate } from "./page-notices";

/**
 * What the step that records flagged pages returns, for the steps after it.
 * It stays small: the page notices, which grow with the pages and their
 * issues, are stored in R2 and only their key travels in the step result.
 */
export interface WritePhaseOutcome extends PageBatchOutcome {
  /** The failures and pages that the page failure budget counts. */
  budgeted: { failedPages: FailedGenerationPage[]; plannedCount: number };
  writtenPageIds: string[];
  /** Null when the run has no instructions fingerprint: the ledger is left alone. */
  runFingerprint: string | null;
  catchUpPageIds: string[];
  publishedBehindPageIds: string[];
  /** The R2 key of the run's page notice payload, or null when there is none. */
  noticesKey: string | null;
}

/**
 * A recorded step result. Results recorded before the write phase grew (a
 * run in flight during a deploy, or a "Continue run" of an older run) hold
 * only the batch outcome, so every other field can be absent.
 */
export type RecordedWritePhaseOutcome =
  & PageBatchOutcome
  & Partial<Omit<WritePhaseOutcome, keyof PageBatchOutcome>>;

/**
 * The write phase outcome of a recorded step result. An older result gets
 * the behavior of the code that recorded it: every regenerated page counts
 * toward the budget, the ledger is left alone, and there are no notices.
 */
export function writePhaseOutcomeOf(
  recorded: RecordedWritePhaseOutcome,
  regeneratePageIds: readonly string[],
): WritePhaseOutcome {
  const failedPageIds = new Set(recorded.failedPages.map((page) => page.id));
  return {
    keys: recorded.keys,
    failedPages: recorded.failedPages,
    budgeted: recorded.budgeted ?? { failedPages: recorded.failedPages, plannedCount: regeneratePageIds.length },
    writtenPageIds: recorded.writtenPageIds ?? regeneratePageIds.filter((pageId) => !failedPageIds.has(pageId)),
    runFingerprint: recorded.runFingerprint ?? null,
    catchUpPageIds: recorded.catchUpPageIds ?? [],
    publishedBehindPageIds: recorded.publishedBehindPageIds ?? [],
    noticesKey: recorded.noticesKey ?? null,
  };
}

const behindInstructionCandidateSchema = z.object({
  pageId: z.string(),
  title: z.string(),
  route: z.string(),
});

const pageNoticePayloadSchema = z.object({
  openIssueNotices: z.array(pageNoticeSchema),
  behindCandidates: z.array(behindInstructionCandidateSchema),
});

/** The notices of a run, stored next to its checkpoints. */
export interface PageNoticePayload {
  openIssueNotices: PageNotice[];
  behindCandidates: BehindInstructionCandidate[];
}

export const EMPTY_PAGE_NOTICE_PAYLOAD: PageNoticePayload = { openIssueNotices: [], behindCandidates: [] };

/** Where a write phase stores its notices, under the run's checkpoint prefix. */
export function pageNoticePayloadKey(checkpointPrefix: string, scope: string): string {
  return `${checkpointPrefix}/${scope}-page-notices.json`;
}

/**
 * Stores the payload and gives its key, or null when there is nothing to
 * store. The same run writes the same key, so a retried step overwrites it.
 */
export async function storePageNoticePayload(
  bucket: Pick<R2Bucket, "put">,
  key: string,
  payload: PageNoticePayload,
): Promise<string | null> {
  if (payload.openIssueNotices.length === 0 && payload.behindCandidates.length === 0) return null;
  await bucket.put(key, JSON.stringify(payload), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return key;
}

/** The stored payload. A missing or malformed object throws, which the notice step logs and skips. */
export async function readPageNoticePayload(
  bucket: Pick<R2Bucket, "get">,
  key: string | null,
): Promise<PageNoticePayload> {
  if (key === null) return EMPTY_PAGE_NOTICE_PAYLOAD;
  const object = await bucket.get(key);
  if (!object) throw new Error(`The page notice payload is missing: ${key}`);
  return pageNoticePayloadSchema.parse(JSON.parse(await object.text()));
}
