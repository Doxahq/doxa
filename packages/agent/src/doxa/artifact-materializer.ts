import type { ArtifactStore } from "../adapters/types";
import type { GeneratedPageContent } from "../types";
import type { CachedPageEntry, DocsManifest, PageTarget } from "../state/types";
import { sha256Hex } from "../utils/hash";
import type { PageWriterResult } from "./types";
import {
  createPageDependencyState,
  emptyPageDependencyState,
} from "../state/page-targets";

export async function materializeWrittenPage(input: {
  artifacts: ArtifactStore;
  target: PageTarget;
  writerResult: PageWriterResult;
  pageInputHash: string;
}): Promise<{ page: GeneratedPageContent; cacheEntry: CachedPageEntry }> {
  await input.artifacts.writeText(input.target.outputPath, input.writerResult.content);
  const dependencies = createPageDependencyState(input.target, {
    sourceFilesRead: input.writerResult.sourceFilesRead,
    sourceFilesDiscovered: input.writerResult.sourceFilesDiscovered,
  });
  const contentHash = await sha256Hex(input.writerResult.content);
  return {
    page: {
      id: input.target.pageId,
      path: input.target.outputPath,
      title: input.target.title,
      content: input.writerResult.content,
      dependencies,
      contentHash,
      pageInputHash: input.pageInputHash,
    },
    cacheEntry: {
      pageId: input.target.pageId,
      outputPath: input.target.outputPath,
      title: input.target.title,
      sectionTitle: input.target.sectionTitle,
      dependencies,
      contentHash,
      pageInputHash: input.pageInputHash,
      generatedAt: new Date().toISOString(),
    },
  };
}

export async function readCachedPage(input: {
  artifacts: ArtifactStore;
  target: PageTarget;
  cacheEntry?: CachedPageEntry;
}): Promise<GeneratedPageContent | null> {
  const content = await input.artifacts.readText(input.target.outputPath);
  if (content === null) return null;
  return {
    id: input.target.pageId,
    path: input.target.outputPath,
    title: input.target.title,
    content,
    dependencies:
      input.cacheEntry?.dependencies ?? emptyPageDependencyState(),
    contentHash:
      input.cacheEntry?.contentHash ?? await sha256Hex(content),
    pageInputHash:
      input.cacheEntry?.pageInputHash ??
      await sha256Hex(JSON.stringify(input.target)),
  };
}

export function mergeManifestPages(input: {
  previousManifest: DocsManifest | null;
  updatedEntries: CachedPageEntry[];
  activePageIds: string[];
  structureHash: string;
  analysisHash: string;
}): DocsManifest {
  const updatedIds = new Set(input.updatedEntries.map((entry) => entry.pageId));
  const activeIds = new Set(input.activePageIds);
  const previousEntries = input.previousManifest?.pages.filter(
    (entry) => !updatedIds.has(entry.pageId) && activeIds.has(entry.pageId),
  ) ?? [];

  return {
    pages: [...previousEntries, ...input.updatedEntries].sort((a, b) => a.pageId.localeCompare(b.pageId)),
    structureHash: input.structureHash,
    analysisHash: input.analysisHash,
    generatedAt: new Date().toISOString(),
  };
}
