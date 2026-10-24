import {
  stagedRuntimePageSchema,
  type PageDependencyState,
  type StagedRuntimePage,
} from "@doxahq/contracts";
import { z } from "zod";
import {
  runResumablePageBatch,
  type GenerationPageCheckpointStore,
  type ResumablePageBatchResult,
  type WrittenPageBatch,
} from "./generation-page-checkpoints";
import { PAGE_CACHE_PREFIX } from "@doxahq/contracts/storage-lifecycle";
import { refreshAgingCacheObject } from "./generation-cache-refresh";
import { sha256Hex } from "./generation-state-store";

const pageCacheEntrySchema = z.object({
  page: stagedRuntimePageSchema,
  writerModel: z.string().trim().min(1),
  writingFingerprint: z.string().trim().min(1),
  createdAt: z.string().datetime(),
}).strict();

/**
 * Everything a written page depends on, and nothing else. A page is keyed by
 * its own inputs, not by a hash of the whole analysis, so a new plan for the
 * same code still finds every page whose spec and sources did not change.
 */
export interface PageCacheKeyInput {
  siteId: string;
  pageId: string;
  /** The page spec: title, description, evidence, reference and handoff. */
  pageInputHash: string;
  /** The content hashes of the source files the page reads. */
  dependencyDigest: string;
  /** The routes that the page may link to. */
  routeRegistryHash: string;
  documentationPolicyVersion: string;
  /** The writer model and prompt contract, or the contract alone across models. */
  writingContract: string;
}

/** Bumped when the key inputs change, so old entries are never misread. */
export const PAGE_CACHE_KEY_VERSION = 2;

export interface PageDependencyDigestInput {
  paths: readonly string[];
  sourceFiles: ReadonlyMap<string, string>;
}

export type PageCacheEntry = z.infer<typeof pageCacheEntrySchema>;

export interface GenerationPageCache {
  getMany(keys: readonly string[]): Promise<Map<string, PageCacheEntry>>;
  putMany(
    writes: readonly { key: string; entry: PageCacheEntry }[],
  ): Promise<void>;
}

export interface PageCacheDescriptor {
  pageId: string;
  pageInputHash: string;
  dependencyDigest: string;
  exactKey: string;
  crossModelKey: string;
}

export interface PageBatchCacheContext {
  cache: GenerationPageCache;
  descriptors: ReadonlyMap<string, PageCacheDescriptor>;
  allowCrossModel: boolean;
  writerModel: string;
  writingFingerprint: string;
  createdAt: string;
  onCrossModelHit?: (
    pageId: string,
    cachedWriterModel: string,
    currentWriterModel: string,
  ) => Promise<void>;
  onCacheError?: (operation: "read" | "write", error: unknown) => void;
}

export async function preparePageBatchCacheContexts(input: {
  batches: readonly (readonly string[])[];
  build: (
    pageIds: readonly string[],
  ) => Promise<PageBatchCacheContext | undefined>;
}): Promise<Array<PageBatchCacheContext | undefined>> {
  if (input.batches.length === 0) return [];
  const context = await input.build(input.batches.flat());
  return input.batches.map((pageIds) =>
    narrowPageBatchCacheContext(context, pageIds)
  );
}

export function narrowPageBatchCacheContext(
  context: PageBatchCacheContext | undefined,
  pageIds: readonly string[],
): PageBatchCacheContext | undefined {
  if (!context) return undefined;
  return {
    ...context,
    descriptors: new Map(pageIds.flatMap((pageId) => {
      const descriptor = context.descriptors.get(pageId);
      return descriptor ? [[pageId, descriptor] as const] : [];
    })),
  };
}

interface RunPageBatchWithCacheInput {
  pageIds: readonly string[];
  store: GenerationPageCheckpointStore;
  cacheContext?: PageBatchCacheContext;
  generate: (
    pendingPageIds: readonly string[],
    checkpoint: (page: StagedRuntimePage) => Promise<void>,
  ) => Promise<WrittenPageBatch>;
}

export interface PageBatchCacheResult extends ResumablePageBatchResult {
  exactHits: number;
  crossModelHits: number;
  generated: number;
}

interface PageCacheBucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: string,
    options?: R2PutOptions,
  ): Promise<R2Object | null>;
}

export async function pageCacheKey(
  input: PageCacheKeyInput,
): Promise<string> {
  const digest = await sha256Hex(JSON.stringify([
    PAGE_CACHE_KEY_VERSION,
    input.siteId,
    input.pageId,
    input.pageInputHash,
    input.dependencyDigest,
    input.routeRegistryHash,
    input.documentationPolicyVersion,
    input.writingContract,
  ]));
  return `${PAGE_CACHE_PREFIX}${digest}.json`;
}

export async function pageDependencyDigest(
  input: PageDependencyDigestInput,
): Promise<string> {
  const files = [...new Set(input.paths)]
    .sort()
    .map((path) => [path, input.sourceFiles.get(path) ?? "absent"]);
  return sha256Hex(JSON.stringify(files));
}

const PAGE_CACHE_CONTENT_TYPE = "application/json; charset=utf-8";

export function createR2GenerationPageCache(
  bucket: PageCacheBucket,
  options: { now?: () => Date } = {},
): GenerationPageCache {
  const now = options.now ?? (() => new Date());
  return {
    async getMany(keys) {
      const entries = await Promise.all(keys.map(async (key) => {
        try {
          const object = await bucket.get(key);
          if (!object) return null;
          const body = await object.text();
          const parsed = pageCacheEntrySchema.safeParse(
            JSON.parse(body) as unknown,
          );
          if (!parsed.success) return null;
          await refreshAgingCacheObject(bucket, {
            key,
            uploaded: object.uploaded,
            body,
            contentType: PAGE_CACHE_CONTENT_TYPE,
          }, now());
          return [key, parsed.data] as const;
        } catch {
          return null;
        }
      }));

      return new Map(entries.filter(
        (entry): entry is readonly [string, PageCacheEntry] => entry !== null,
      ));
    },

    async putMany(writes) {
      await Promise.all(writes.map(async ({ key, entry }) => {
        const parsed = pageCacheEntrySchema.parse(entry);
        await bucket.put(key, JSON.stringify(parsed), {
          httpMetadata: {
            contentType: PAGE_CACHE_CONTENT_TYPE,
          },
        });
      }));
    },
  };
}

export function validCachedPage(
  entry: PageCacheEntry | undefined,
  pageId: string,
  pageInputHash: string,
): StagedRuntimePage | null {
  if (
    !entry
    || entry.page.id !== pageId
    || entry.page.pageInputHash !== pageInputHash
  ) {
    return null;
  }
  return entry.page;
}

export async function buildPageCacheDescriptor(input: {
  key: Omit<PageCacheKeyInput, "dependencyDigest" | "writingContract">;
  paths: readonly string[];
  sourceFiles: ReadonlyMap<string, string>;
  exactWritingContract: string;
  crossModelWritingContract: string;
}): Promise<PageCacheDescriptor> {
  const dependencyDigest = await pageDependencyDigest({
    paths: input.paths,
    sourceFiles: input.sourceFiles,
  });
  const exactKey = await pageCacheKey({
    ...input.key,
    dependencyDigest,
    writingContract: input.exactWritingContract,
  });
  const crossModelKey = await pageCacheKey({
    ...input.key,
    dependencyDigest,
    writingContract: input.crossModelWritingContract,
  });
  return {
    pageId: input.key.pageId,
    pageInputHash: input.key.pageInputHash,
    dependencyDigest,
    exactKey,
    crossModelKey,
  };
}

export function pageDependencyPaths(input: {
  declaredSourceEvidence: readonly string[];
  baselineDependencies?: PageDependencyState;
}): string[] {
  return [...new Set([
    ...input.declaredSourceEvidence,
    ...(input.baselineDependencies?.sourceFilesRead ?? []),
    ...(input.baselineDependencies?.sourceEvidenceFiles ?? []),
  ])].sort();
}

export function structureSourceEvidenceByPageId(
  checkpoint: string,
): Map<string, string[]> {
  const parsed: unknown = JSON.parse(checkpoint);
  const result = new Map<string, string[]>();
  if (!isRecord(parsed) || !Array.isArray(parsed.sections)) {
    throw new Error("Structure checkpoint does not contain sections.");
  }

  for (const section of parsed.sections) {
    if (!isRecord(section) || !Array.isArray(section.pages)) {
      throw new Error("Structure checkpoint contains an invalid section.");
    }
    for (const page of section.pages) {
      if (
        !isRecord(page)
        || typeof page.id !== "string"
        || (page.subPages !== undefined &&
          (!Array.isArray(page.subPages) || page.subPages.length > 0))
      ) {
        throw new Error("Structure checkpoint contains an invalid page.");
      }
      result.set(page.id, sourceEvidencePaths(page.sourceEvidence));
    }
  }
  return result;
}

export async function runPageBatchWithCache(
  input: RunPageBatchWithCacheInput,
): Promise<PageBatchCacheResult> {
  let exactHits = 0;
  let crossModelHits = 0;
  let generated = 0;
  const result = await runResumablePageBatch({
    pageIds: input.pageIds,
    store: input.store,
    generate: async (pendingPageIds, checkpoint) => {
      const cacheContext = input.cacheContext;
      if (!cacheContext) {
        const written = await input.generate(pendingPageIds, checkpoint);
        generated += written.pages.length;
        return written;
      }

      const descriptors = pendingPageIds.map((pageId) => {
        const descriptor = cacheContext.descriptors.get(pageId);
        if (!descriptor) {
          throw new Error(`Page cache descriptor is missing: ${pageId}`);
        }
        return descriptor;
      });
      const exactEntries = await readCacheEntries(
        cacheContext,
        descriptors.map((descriptor) => descriptor.exactKey),
      );
      const exactHitPageIds = new Set<string>();
      for (const descriptor of descriptors) {
        const page = validCachedPage(
          exactEntries.get(descriptor.exactKey),
          descriptor.pageId,
          descriptor.pageInputHash,
        );
        if (!page) continue;
        exactHitPageIds.add(descriptor.pageId);
        await checkpoint(page);
      }
      exactHits += exactHitPageIds.size;

      const exactMisses = descriptors.filter(
        (descriptor) => !exactHitPageIds.has(descriptor.pageId),
      );
      const crossModelHitPageIds = new Set<string>();
      if (cacheContext.allowCrossModel && exactMisses.length > 0) {
        const crossEntries = await readCacheEntries(
          cacheContext,
          exactMisses.map((descriptor) => descriptor.crossModelKey),
        );
        for (const descriptor of exactMisses) {
          const entry = crossEntries.get(descriptor.crossModelKey);
          const page = validCachedPage(
            entry,
            descriptor.pageId,
            descriptor.pageInputHash,
          );
          if (!page || !entry) continue;
          crossModelHitPageIds.add(descriptor.pageId);
          await checkpoint(page);
          await cacheContext.onCrossModelHit?.(
            descriptor.pageId,
            entry.writerModel,
            cacheContext.writerModel,
          );
        }
      }
      crossModelHits += crossModelHitPageIds.size;

      const freshPageIds = exactMisses
        .filter(
          (descriptor) => !crossModelHitPageIds.has(descriptor.pageId),
        )
        .map((descriptor) => descriptor.pageId);
      if (freshPageIds.length === 0) return { pages: [], failedPages: [] };

      // Each page goes to the cache as soon as it checkpoints, so a batch
      // that fails later still leaves its written pages for the next run.
      const cachedPageIds = new Set<string>();
      const checkpointAndCache = async (page: StagedRuntimePage): Promise<void> => {
        await checkpoint(page);
        if (cachedPageIds.has(page.id)) return;
        cachedPageIds.add(page.id);
        await writeFreshPages(cacheContext, [page]);
      };
      const written = await input.generate(freshPageIds, checkpointAndCache);
      generated += written.pages.length;
      await writeFreshPages(
        cacheContext,
        written.pages.filter((page) => !cachedPageIds.has(page.id)),
      );
      return written;
    },
  });
  return {
    ...result,
    exactHits,
    crossModelHits,
    generated,
  };
}

async function readCacheEntries(
  context: PageBatchCacheContext,
  keys: readonly string[],
): Promise<Map<string, PageCacheEntry>> {
  try {
    return await context.cache.getMany(keys);
  } catch (error) {
    context.onCacheError?.("read", error);
    return new Map();
  }
}

async function writeFreshPages(
  context: PageBatchCacheContext,
  pages: readonly StagedRuntimePage[],
): Promise<void> {
  const writes: { key: string; entry: PageCacheEntry }[] = [];
  for (const page of pages) {
    const descriptor = context.descriptors.get(page.id);
    if (!descriptor || page.pageInputHash !== descriptor.pageInputHash) {
      continue;
    }
    const entry: PageCacheEntry = {
      page,
      writerModel: context.writerModel,
      writingFingerprint: context.writingFingerprint,
      createdAt: context.createdAt,
    };
    writes.push(
      { key: descriptor.exactKey, entry },
      { key: descriptor.crossModelKey, entry },
    );
  }
  if (writes.length === 0) return;

  try {
    await context.cache.putMany(writes);
  } catch (error) {
    context.onCacheError?.("write", error);
  }
}

function sourceEvidencePaths(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Page source evidence must be an array.");
  }
  const paths = value.map((evidence) => {
    if (!isRecord(evidence) || typeof evidence.path !== "string") {
      throw new Error("Page source evidence contains an invalid path.");
    }
    return evidence.path;
  });
  return [...new Set(paths)].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
