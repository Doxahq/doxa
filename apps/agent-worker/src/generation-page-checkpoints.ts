import {
  stagedRuntimePageSchema,
  type FailedStagePage,
  type StagedRuntimePage,
} from "@doxahq/contracts";

export interface GenerationPageCheckpointStore {
  key(pageId: string): string;
  read(pageId: string): Promise<StagedRuntimePage | null>;
  write(page: StagedRuntimePage): Promise<string>;
}

export function parseGenerationPageCheckpoint(
  raw: unknown,
): StagedRuntimePage[] {
  const page = stagedRuntimePageSchema.safeParse(raw);
  if (page.success) return [page.data];

  const batch = stagedRuntimePageSchema.array().min(1).safeParse(raw);
  if (batch.success) return batch.data;

  throw new Error("Stored generation page checkpoint is invalid.");
}

/** What a write stage returns: the pages it wrote and the pages it gave up on. */
export interface WrittenPageBatch {
  pages: readonly StagedRuntimePage[];
  failedPages: readonly FailedStagePage[];
}

interface RunResumablePageBatchInput {
  pageIds: readonly string[];
  store: GenerationPageCheckpointStore;
  generate: (
    pendingPageIds: readonly string[],
    checkpoint: (page: StagedRuntimePage) => Promise<void>,
  ) => Promise<WrittenPageBatch>;
}

export interface ResumablePageBatchResult {
  /** Checkpoint keys of the written pages, in batch order. */
  keys: string[];
  failedPages: FailedStagePage[];
}

/**
 * Writes the pages that have no checkpoint yet. A page that the stage did
 * not write counts as failed, with the stage's reason when it gave one.
 */
export async function runResumablePageBatch(
  input: RunResumablePageBatchInput,
): Promise<ResumablePageBatchResult> {
  const expectedPageIds = new Set(input.pageIds);
  const existingPages = await Promise.all(
    input.pageIds.map((pageId) => input.store.read(pageId)),
  );
  const completedPageIds = new Set(
    existingPages.flatMap((page) => page ? [page.id] : []),
  );
  const pendingPageIds = input.pageIds.filter(
    (pageId) => !completedPageIds.has(pageId),
  );

  const checkpoint = async (page: StagedRuntimePage): Promise<void> => {
    if (!expectedPageIds.has(page.id)) {
      throw new Error(
        `Write stage checkpointed an unexpected page: ${page.id}`,
      );
    }
    await input.store.write(page);
  };

  const reportedFailures = new Map<string, FailedStagePage>();
  if (pendingPageIds.length > 0) {
    const written = await input.generate(pendingPageIds, checkpoint);
    for (const page of written.pages) {
      await checkpoint(page);
    }
    for (const failed of written.failedPages) {
      if (expectedPageIds.has(failed.id)) reportedFailures.set(failed.id, failed);
    }
  }

  const keys: string[] = [];
  const failedPages: FailedStagePage[] = [];
  for (const pageId of input.pageIds) {
    if (await input.store.read(pageId)) {
      keys.push(input.store.key(pageId));
      continue;
    }
    failedPages.push(reportedFailures.get(pageId) ?? {
      id: pageId,
      title: pageId,
      reason: "The write stage returned no page and no failure for it.",
    });
  }
  return { keys, failedPages };
}

interface PageCheckpointBucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: string,
    options?: R2PutOptions,
  ): Promise<R2Object | null>;
}

export function createR2GenerationPageCheckpointStore(
  bucket: PageCheckpointBucket,
  prefix: string,
): GenerationPageCheckpointStore {
  const key = (pageId: string): string =>
    `${prefix}/${encodeURIComponent(pageId)}.json`;

  return {
    key,
    async read(pageId) {
      const object = await bucket.get(key(pageId));
      if (!object) return null;
      const parsed = stagedRuntimePageSchema.safeParse(
        JSON.parse(await object.text()) as unknown,
      );
      if (!parsed.success || parsed.data.id !== pageId) {
        throw new Error(`Stored page checkpoint is invalid: ${key(pageId)}`);
      }
      return parsed.data;
    },
    async write(page) {
      const parsed = stagedRuntimePageSchema.parse(page);
      const checkpointKey = key(parsed.id);
      await bucket.put(checkpointKey, JSON.stringify(parsed), {
        httpMetadata: {
          contentType: "application/json; charset=utf-8",
        },
      });
      return checkpointKey;
    },
  };
}
