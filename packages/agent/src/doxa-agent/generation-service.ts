import { mkdir, readdir, rm, writeFile } from "fs/promises";
import { dirname, join, relative } from "path";
import {
  createToolResultCache,
  createTrackedTools,
  isRunStoppingModelError,
  providerCachesPrompts,
} from "../core";
import type { AgentUsageCallback, Provider } from "../core";
import type {
  AgentConfig,
  AgentProgressCallback,
  DocPage,
  DocumentationStructure,
  GeneratedPageContent,
  GenerationExecutionOptions,
  GenerationResult,
  DocsQualityIssue,
  DocsQualityReport,
  PageFailureAction,
  PageGenerationFailure,
  WriterContext,
  WriterValidationConfig,
} from "../types";
import { DEFAULT_WRITER_VALIDATION } from "../types";
import { normalizeProjectAnalysis } from "../utils/analysis-normalizer";
import { formatDocsQualityIssues, validateGeneratedDocs } from "../utils/docs-quality-validator";
import type {
  AgentCacheManager,
  CachedPageEntry,
  DocsCacheCheckResult,
  SourceChangeSet,
} from "../cache";
import { hashObject } from "../utils/hash";
import {
  explainedBaselineHashes,
  legacyPageInputFields,
  pageInputFields,
  type PageInputFields,
} from "../state/page-input-hash";
import { createGate, mapWithConcurrency } from "../utils/concurrency";
import { DEFAULT_CONCURRENCY, DEFAULT_OUTPUT_DIR } from "./constants";
import {
  DocsQualityValidationError,
  PageGenerationAbortedError,
  TestPageGenerationError,
} from "./errors";
import type { TestPageFailure } from "./errors";
import { createProviderFromConfig } from "./provider-factory";
import {
  detectPageType,
  type PageType,
  resolveWriterMaxSteps,
  writeDocPage,
  writeDocPageTracked,
} from "./writer";
import { PageValidationExhaustedError } from "./writer-pipeline";
import type { ValidationHistoryEntry } from "../utils/retry-hint";
import {
  flattenStructure,
  stablePageId,
  type FlattenedStructurePage,
} from "./structure-utils";
import {
  buildRouteRegistry,
  rewriteInternalLinks,
  routeFromOutputPath,
  routeRegistrySummary,
  type RouteRegistry,
} from "./route-registry";
import { hashString, readExistingPages } from "./page-io";
import { orderAndPersistNav } from "./nav-order";
import { prompts } from "./prompts";
import type { PromptRegistry } from "./prompts";
import { documentationBriefFingerprint, resolveDocumentationBrief } from "./documentation-policy";
import {
  DEFAULT_DOCS_QUALITY_MAX_REPAIRS,
  DEFAULT_DOCS_QUALITY_MAX_REPAIRS_PER_PAGE,
  DEFAULT_PAGE_FAILURE_MAX_RETRIES,
  canRetryPageFailure,
  canRunDocsQualityRepair,
  canRunDocsQualityRepairForPage,
} from "./retry-policy";
import { resolveProjectPath } from "../core/tools/project-path";
import {
  createPageDependencyState,
  emptyPageDependencyState,
  type RecordedPageSources,
} from "../state/page-targets";
import {
  buildPageEvidenceBundle,
  type PageEvidenceBundle,
} from "./evidence-bundle";
import {
  assessDocsQualityRepairCandidate,
  blockingDocsQualityIssues,
  buildDocsQualityRepairFeedback,
  type DocsQualityRepairRejection,
} from "./docs-quality-repair";
import {
  isRestEndpointPage,
  stripRestEndpointReferenceBlock,
} from "./rest-endpoint-page";
import {
  repairQualitySections,
  type SectionRepairOutcome,
} from "./section-quality-repair";
import { splicedPageInstructions, validateSplicedPage } from "./spliced-page-gate";
import { openIssuesOfShippedPage, softContentIssuesOfPage } from "../utils/page-open-issues";
import type { PageOpenIssue } from "@doxahq/contracts/generation-reviews";
import { deterministicPageRendererFor } from "./deterministic-pages";

export type PageWriteTarget = FlattenedStructurePage;

interface WrittenPage {
  page: GeneratedPageContent;
  cacheEntry: CachedPageEntry;
}

/** Page text plus the source files its author used, before links are rewritten. */
interface AuthoredPage {
  content: string;
  recorded: RecordedPageSources;
  /** Issues the page still has when its author kept it. */
  openIssues?: PageOpenIssue[];
}

interface FailedPageWrite {
  target: PageWriteTarget;
  error: unknown;
}

function isFailedPageWrite(value: unknown): value is FailedPageWrite {
  if (typeof value !== "object" || value === null) return false;
  if (!("target" in value) || !("error" in value)) return false;

  const target = value.target;
  return (
    typeof target === "object" &&
    target !== null &&
    "sectionTitle" in target &&
    typeof target.sectionTitle === "string" &&
    "path" in target &&
    typeof target.path === "string" &&
    "page" in target &&
    typeof target.page === "object" &&
    target.page !== null
  );
}

interface PageWriteOptions {
  persist?: boolean;
}

interface DocsQualityRepairState {
  resolvedRules: Set<string>;
  previousRejection?: DocsQualityRepairRejection;
}

interface DocsQualityRepairJob {
  target: PageWriteTarget;
  pageRepairNumber: number;
  currentPage: GeneratedPageContent;
  currentIssues: DocsQualityIssue[];
  repairState: DocsQualityRepairState;
  retryHint: string;
}

interface DocumentationGenerationCacheContext {
  sourceChanges?: SourceChangeSet;
}

type AgentConfigWithInternalPrompts = AgentConfig & {
  promptRegistry?: PromptRegistry;
};

function resolvePromptRegistry(config: AgentConfig): PromptRegistry {
  return (config as AgentConfigWithInternalPrompts).promptRegistry ?? prompts;
}

function pageTitle(target: PageWriteTarget): string {
  return target.page.title;
}

function pageId(target: PageWriteTarget): string {
  return stablePageId(target);
}

export function selectGenerationTargets(
  structure: DocumentationStructure,
  requestedPageIds?: readonly string[],
): PageWriteTarget[] {
  const allTargets = flattenStructure(structure);
  if (!requestedPageIds) return allTargets;

  const requested = new Set<string>();
  for (const requestedPageId of requestedPageIds) {
    if (requested.has(requestedPageId)) {
      throw new Error(`Requested generation page ID is duplicated: ${requestedPageId}`);
    }
    requested.add(requestedPageId);
  }

  const available = new Set(allTargets.map(pageId));
  for (const requestedPageId of requested) {
    if (!available.has(requestedPageId)) {
      throw new Error(`Requested generation page ID was not found: ${requestedPageId}`);
    }
  }

  return allTargets.filter((target) => requested.has(pageId(target)));
}

function hashPageInput(value: unknown): string {
  return hashObject(value);
}

function buildPageTargetInputHashMap(
  targets: PageWriteTarget[],
  fieldsOf: PageInputFields = pageInputFields,
): Record<string, string> {
  return Object.fromEntries(targets.map((target) => [pageId(target), hashPageInput(fieldsOf(target))]));
}

/** The hashes to compare a baseline's pages with; see {@link explainedBaselineHashes}. */
export function baselinePageInputHashes(
  structure: DocumentationStructure,
  stored: Readonly<Record<string, string>>,
): Record<string, string> {
  const targets = flattenStructure(structure);
  return explainedBaselineHashes({
    stored,
    current: buildPageTargetInputHashMap(targets),
    legacy: buildPageTargetInputHashMap(targets, legacyPageInputFields),
  });
}

export function buildPageInputHashMap(
  structure: DocumentationStructure,
): Record<string, string> {
  return buildPageTargetInputHashMap(flattenStructure(structure));
}

function writerAnalysisHash(context: WriterContext | undefined): string {
  if (!context) return "";
  const documentationBrief = resolveDocumentationBrief(context.documentationBrief);
  return hashObject({
    analysis: context.analysis,
    documentationBriefFingerprint: documentationBriefFingerprint(documentationBrief),
  });
}

async function resolveSourceChangesForDocs(
  cacheManager: AgentCacheManager,
  cacheContext?: DocumentationGenerationCacheContext,
): Promise<SourceChangeSet> {
  if (cacheContext?.sourceChanges) {
    return cacheContext.sourceChanges;
  }

  const analysisCheck = await cacheManager.checkAnalysis();
  return {
    changedFiles: analysisCheck.changedFiles,
    addedFiles: analysisCheck.addedFiles,
    deletedFiles: analysisCheck.deletedFiles,
  };
}

function createPageFailure(
  target: PageWriteTarget,
  fullOutputDir: string,
  reason: string,
  attemptLimit: number,
  retryCount: number,
): PageGenerationFailure {
  return {
    pageId: pageId(target),
    title: pageTitle(target),
    sectionTitle: target.sectionTitle,
    outputPath: join(fullOutputDir, target.path),
    reason,
    attemptLimit,
    retryCount,
  };
}

function createQualityFailure(
  target: PageWriteTarget,
  fullOutputDir: string,
  issue: DocsQualityIssue,
  attemptLimit: number,
  retryCount: number,
): PageGenerationFailure {
  return createPageFailure(
    target,
    fullOutputDir,
    `${issue.rule}: ${issue.message}${issue.excerpt ? ` (${issue.excerpt})` : ""}`,
    attemptLimit,
    retryCount,
  );
}

function generationErrorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function writerFailureLogMessage(title: string, error: unknown): string {
  return `Failed to write "${title}": ${generationErrorReason(error)}`;
}

interface PageWriterRetryContext {
  initialRetryHint?: string;
  initialValidationHistory?: readonly ValidationHistoryEntry[];
  pageRetry: number;
  /** Writes this retry with another model, for the last retry of a failing page. */
  provider?: Provider;
}

function repairContextFromError(
  error: unknown,
  fallbackPageRetry: number,
): PageWriterRetryContext {
  if (error instanceof PageValidationExhaustedError) {
    const latestPageRetry = error.validationHistory.at(-1)?.pageRetry;
    return {
      initialValidationHistory: error.validationHistory,
      pageRetry: latestPageRetry === undefined ? fallbackPageRetry : latestPageRetry + 1,
    };
  }
  return {
    initialRetryHint: [
      "OUTER RETRY FEEDBACK — the previous page generation attempt failed.",
      `Failure: ${generationErrorReason(error)}`,
      "Repair the page specifically for this failure. Preserve correct, source-grounded sections and return a complete MDX page.",
    ].join("\n"),
    pageRetry: fallbackPageRetry,
  };
}

/**
 * The provider for the last retry of a failing page: the same model API with
 * the configured fallback model. An injected provider has no model to swap.
 */
function createWriterFallbackProvider(config: AgentConfig): Provider | undefined {
  const model = config.writerFallbackModel;
  if (!model || config.provider || model === config.model) return undefined;
  return createProviderFromConfig({ ...config, model });
}

async function resolvePageFailureAction(
  config: AgentConfig,
  failure: PageGenerationFailure,
): Promise<PageFailureAction> {
  return config.onPageFailure ? await config.onPageFailure(failure) : "skip";
}

async function resolveDocsQualityFailureAction(
  config: AgentConfig,
  failure: PageGenerationFailure,
): Promise<PageFailureAction> {
  const handler = config.onDocsQualityFailure ?? config.onPageFailure;
  return handler ? await handler(failure) : "skip";
}

function routeFromTargetPath(path: string): string {
  return routeFromOutputPath(path);
}

function findTargetForQualityIssue(
  issue: DocsQualityIssue,
  targets: PageWriteTarget[],
): PageWriteTarget | undefined {
  if (issue.route) {
    const routeMatch = targets.find((target) => routeFromTargetPath(target.path) === issue.route);
    if (routeMatch) return routeMatch;
  }
  if (issue.title) {
    return targets.find((target) => pageTitle(target) === issue.title);
  }
  return undefined;
}

function qualityIssuesForTarget(
  report: DocsQualityReport,
  target: PageWriteTarget,
  targets: PageWriteTarget[],
): DocsQualityIssue[] {
  const targetId = pageId(target);
  return report.issues.filter((issue) => {
    const issueTarget = findTargetForQualityIssue(issue, targets);
    return issueTarget ? pageId(issueTarget) === targetId : false;
  });
}

function replaceGeneratedPage(
  pages: readonly GeneratedPageContent[],
  candidate: GeneratedPageContent,
): GeneratedPageContent[] {
  return pages.map((page) => page.id === candidate.id ? candidate : page);
}

async function rewriteGeneratedPageLinks(
  page: GeneratedPageContent,
  registry: RouteRegistry,
): Promise<GeneratedPageContent> {
  const rewritten = rewriteInternalLinks(page.content, registry);
  if (rewritten === page.content) return page;
  await writeFile(page.path, rewritten, "utf-8");
  return {
    ...page,
    content: rewritten,
    contentHash: hashString(rewritten),
  };
}

async function rewriteGeneratedPagesLinks(
  pages: GeneratedPageContent[],
  registry: RouteRegistry,
): Promise<GeneratedPageContent[]> {
  const rewritten = await Promise.all(pages.map((page) => rewriteGeneratedPageLinks(page, registry)));
  pages.length = 0;
  pages.push(...rewritten);
  return pages;
}

async function pruneStaleMarkdownFiles(fullOutputDir: string, activePages: GeneratedPageContent[]): Promise<void> {
  const activeRelativePaths = new Set(
    activePages.map((page) => relative(fullOutputDir, page.path).replace(/\\/g, "/"))
  );
  const files = await listMarkdownFiles(fullOutputDir);
  await Promise.all(
    files
      .filter((file) => !activeRelativePaths.has(relative(fullOutputDir, file).replace(/\\/g, "/")))
      .map((file) => rm(file, { force: true })),
  );
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(fullPath));
    } else if (entry.isFile() && /\.(md|mdx)$/i.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Generate all documentation pages with parallel page writing and smart caching.
 *
 * With cache:
 * - Checks which pages need regeneration based on source file changes
 * - Skips pages whose dependencies haven't changed
 * - Uses tracked tools to record per-page file dependencies
 * - Saves the manifest for future cache checks
 */
export async function generateDocumentation(
  config: AgentConfig,
  structure: DocumentationStructure,
  onProgress?: AgentProgressCallback,
  writerContext?: WriterContext,
  cacheManager?: AgentCacheManager,
  cacheContext?: DocumentationGenerationCacheContext,
  execution: GenerationExecutionOptions = {},
): Promise<GenerationResult> {
  const outputDir = config.outputDir || DEFAULT_OUTPUT_DIR;
  const artifactRoot = config.artifactRoot ?? config.cwd;
  const fullOutputDir = await resolveProjectPath(artifactRoot, outputDir);
  await mkdir(fullOutputDir, { recursive: true });
  const writerLimiter = config.pageWriterLimiter;
  // With a shared limiter the pool can hold its ceiling; the limiter sets the width.
  const concurrency = writerLimiter?.max ?? config.concurrency ?? DEFAULT_CONCURRENCY;
  const writerMaxSteps = resolveWriterMaxSteps(config.writerMaxSteps);
  const normalizedWriterContext = writerContext
    ? {
        ...writerContext,
        analysis: normalizeProjectAnalysis(writerContext.analysis),
        documentationBrief: resolveDocumentationBrief(
          writerContext.documentationBrief ?? config.documentationBrief,
        ),
      }
    : undefined;
  const promptRegistry = resolvePromptRegistry(config);

  const provider = createProviderFromConfig(config);
  const fallbackProvider = createWriterFallbackProvider(config);

  onProgress?.({ stage: "gathering", message: "Preparing to write documentation...", progress: 0 });

  const allPages = flattenStructure(structure);
  const selectedPages = selectGenerationTargets(structure, execution.pageIds);
  const isPartialGeneration = execution.pageIds !== undefined;
  const routeRegistry = buildRouteRegistry(structure);
  const allPageIds = allPages.map(pageId);
  const pageInputHashes = buildPageTargetInputHashMap(allPages);

  // Check cache for which pages need regeneration
  let docsCheck: DocsCacheCheckResult | null = null;
  const cachedPageEntries: CachedPageEntry[] = [];

  if (cacheManager) {
    const structureHash = hashObject(structure);
    const analysisHash = writerAnalysisHash(normalizedWriterContext);

    const sourceChanges = await resolveSourceChangesForDocs(cacheManager, cacheContext);

    docsCheck = await cacheManager.checkDocs(
      structureHash,
      analysisHash,
      allPageIds,
      pageInputHashes,
      sourceChanges.changedFiles,
      sourceChanges.addedFiles,
      sourceChanges.deletedFiles
    );

    if (!docsCheck.needsRegeneration) {
      // Read existing files and return them
      const existingPages = await readExistingPages(fullOutputDir, allPages);
      await rewriteGeneratedPagesLinks(existingPages, routeRegistry);

      // Cache-only paths still need a nav-order manifest. The ordering pass
      // is a no-op when an existing manifest already covers every page.
      try {
        await orderAndPersistNav({
          provider,
          pages: existingPages,
          structure,
          fullOutputDir,
          cwd: config.cwd,
          onProgress,
          skipIfManifestCovers: true,
          promptRegistry,
          abortController: config.abortController,
          analysis: normalizedWriterContext?.analysis,
          documentationBrief: normalizedWriterContext?.documentationBrief,
          onModelUsage: config.onModelUsage,
          modelCallTimeoutMs: config.modelCallTimeoutMs,
          modelCallMaxDurationMs: config.modelCallMaxDurationMs,
        });
      } catch (error) {
        config.abortController?.signal.throwIfAborted();
        const message = error instanceof Error ? error.message : "Unknown ordering error";
        onProgress?.({
          stage: "ordering",
          message: `Ordering pass skipped: ${message}`,
          progress: 95,
        });
      }

      onProgress?.({
        stage: "complete",
        message: `All ${allPages.length} pages up to date (cached)`,
        progress: 100,
      });

      const qualityReport = validateGeneratedDocs(existingPages, {
        outputDir: fullOutputDir,
        structure,
        analysis: normalizedWriterContext?.analysis,
        requireAllStructurePages: true,
        failOnWarnings: config.docsQuality?.failOnWarnings,
        routeRegistry,
      });

      if (config.docsQuality?.enabled !== false && !qualityReport.ok) {
        throw new DocsQualityValidationError(
          `Cached docs failed quality validation: ${formatDocsQualityIssues(qualityReport)}`,
        );
      }

      await pruneStaleMarkdownFiles(fullOutputDir, existingPages);

      return {
        pages: existingPages,
        totalPages: existingPages.length,
        outputDir: fullOutputDir,
        failedPages: [],
        skippedPages: [],
        qualityReport,
      };
    }

    // Report cache status
    const skipped = docsCheck.pagesFromCache.length;
    const regenerating = docsCheck.pagesToRegenerate.length;
    onProgress?.({
      stage: "gathering",
      message: `Regenerating ${regenerating} page(s), skipping ${skipped} cached page(s)`,
      progress: 5,
    });
  }

  // Filter pages to only those that need regeneration
  const pagesToWrite = docsCheck
    ? selectedPages.filter((p) => {
        return docsCheck!.pagesToRegenerate.includes(pageId(p));
      })
    : selectedPages;

  const toolResultCache = createToolResultCache();
  const evidenceBundleByPageId = new Map<
    string,
    Promise<PageEvidenceBundle>
  >();
  const reportedWriterExplorationPageIds = new Set<string>();
  const evidenceBundleFor = (
    target: PageWriteTarget,
  ): Promise<PageEvidenceBundle> | undefined => {
    if (
      config.writerExploration !== "evidence_first" ||
      !normalizedWriterContext
    ) {
      return undefined;
    }
    const targetPageId = pageId(target);
    const existing = evidenceBundleByPageId.get(targetPageId);
    if (existing) return existing;
    const pending = buildPageEvidenceBundle({
      cwd: config.cwd,
      pageId: targetPageId,
      page: target.page,
      analysis: normalizedWriterContext.analysis,
      handoffBrief: normalizedWriterContext.writerHandoff?.pages.find(
        (brief) => brief.pageId === targetPageId,
      ),
    });
    evidenceBundleByPageId.set(targetPageId, pending);
    return pending;
  };
  const generatedPages: GeneratedPageContent[] = [];
  const failedPages: PageGenerationFailure[] = [];
  const skippedPages: PageGenerationFailure[] = [];
  const cacheEntryByPageId = new Map<string, CachedPageEntry>();
  const skippedQualityRoutes = new Set<string>();
  const qualityRetryCounts = new Map<string, number>();
  const qualityRepairStateByPageId = new Map<string, DocsQualityRepairState>();
  const totalPages = pagesToWrite.length;
  const inputOrderByPageId = new Map(
    pagesToWrite.map((target, index) => [pageId(target), index]),
  );
  let completedCount = 0;
  const attemptLimit = (config.writerValidation ?? DEFAULT_WRITER_VALIDATION).maxAttempts;

  // The first finished model call has written the shared prompt prefix to
  // the provider cache, so the other pages start after it.
  const firstWriterCall = createGate();
  const onWriterModelUsage: AgentUsageCallback = (record) => {
    firstWriterCall.open();
    return config.onModelUsage?.(record);
  };

  const writePageWithModel = async (
    target: PageWriteTarget,
    retryContext: PageWriterRetryContext,
  ): Promise<AuthoredPage> => {
    const targetPageId = pageId(target);
    const evidenceBundle = await evidenceBundleFor(target);
    if (!reportedWriterExplorationPageIds.has(targetPageId)) {
      reportedWriterExplorationPageIds.add(targetPageId);
      config.onWriterExplorationResolved?.({
        pageId: targetPageId,
        mode:
          config.writerExploration === "evidence_first" &&
            evidenceBundle?.sufficient === true
            ? "evidence_first"
            : "agentic_fallback",
      });
    }

    const trackedTools = createTrackedTools(config.cwd, "read_only", {
      resultCache: toolResultCache,
    });
    const written = await writeDocPageTracked(
      retryContext.provider ?? provider,
      config.cwd,
      target.sectionTitle,
      targetPageId,
      target.page,
      normalizedWriterContext,
      trackedTools,
      config.componentPlaybook,
      config.writerValidation ?? DEFAULT_WRITER_VALIDATION,
      promptRegistry,
      config.abortController,
      retryContext.initialRetryHint,
      retryContext.initialValidationHistory,
      retryContext.pageRetry,
      artifactRoot,
      config.onWriterDiagnostic,
      onWriterModelUsage,
      config.onRepairDiagnostic,
      config.onSpan,
      config.writerExploration,
      evidenceBundle,
      config.modelCallTimeoutMs,
      config.modelCallMaxDurationMs,
      writerMaxSteps,
    );
    return {
      content: written.content,
      openIssues: written.openIssues,
      recorded: {
        sourceFilesRead: trackedTools.getAccessedFiles(),
        sourceFilesDiscovered: trackedTools.getDiscoveredFiles(),
        evidenceBundlePaths: evidenceBundle?.paths,
      },
    };
  };

  // A template page reads no files, so its dependencies are its declared
  // source evidence. A retry renders the same page again; it has no hint to use.
  const authorPage = async (
    target: PageWriteTarget,
    retryContext: PageWriterRetryContext,
  ): Promise<AuthoredPage> => {
    const renderer = deterministicPageRendererFor(target.page);
    if (!renderer) return writePageWithModel(target, retryContext);

    const content = await renderer.render({
      pageId: pageId(target),
      page: target.page,
      writerContext: normalizedWriterContext,
      writerValidation: config.writerValidation ?? DEFAULT_WRITER_VALIDATION,
      promptRegistry,
      onSpan: config.onSpan,
    });
    return { content, recorded: {} };
  };

  /** Holds a writer slot while a page is authored; a finished page widens the limit. */
  const withWriterSlot = async <T,>(author: () => Promise<T>): Promise<T> => {
    if (!writerLimiter) return author();
    const release = await writerLimiter.acquire(config.abortController?.signal);
    try {
      const result = await author();
      writerLimiter.recordSuccess();
      return result;
    } finally {
      release();
    }
  };

  // A template page makes no model call, so it never waits for a writer slot.
  const authorPageInSlot = (
    target: PageWriteTarget,
    retryContext: PageWriterRetryContext,
  ): Promise<AuthoredPage> =>
    deterministicPageRendererFor(target.page)
      ? authorPage(target, retryContext)
      : withWriterSlot(() => authorPage(target, retryContext));

  const writePage = async (
    target: PageWriteTarget,
    retryContext: PageWriterRetryContext = { pageRetry: 0 },
    options: PageWriteOptions = {},
  ): Promise<WrittenPage> =>
    toWrittenPage(
      target,
      await authorPageInSlot(target, retryContext),
      options,
    );

  const toWrittenPage = async (
    target: PageWriteTarget,
    authored: AuthoredPage,
    options: PageWriteOptions,
  ): Promise<WrittenPage> => {
    const title = pageTitle(target);
    const targetPageId = pageId(target);
    const content = rewriteInternalLinks(authored.content, routeRegistry);

    const fullPath = await resolveProjectPath(fullOutputDir, target.path);
    if (options.persist !== false) {
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, "utf-8");
    }
    const dependencies = createPageDependencyState({
      sourceEvidence: target.page.sourceEvidence ?? [],
      canonicalRoute: target.page.canonicalRoute,
      reference: target.page.reference,
    }, authored.recorded);
    const contentHash = hashString(content);
    const pageInputHash = pageInputHashes[targetPageId];

    return {
      page: {
        id: targetPageId,
        path: fullPath,
        title,
        content,
        dependencies,
        contentHash,
        pageInputHash,
        ...(authored.openIssues?.length ? { openIssues: authored.openIssues } : {}),
      },
      cacheEntry: {
        pageId: targetPageId,
        outputPath: target.path,
        title,
        sectionTitle: target.sectionTitle,
        dependencies,
        contentHash,
        pageInputHash,
        generatedAt: new Date().toISOString(),
      },
    };
  };

  const upsertWrittenPage = (target: PageWriteTarget, written: WrittenPage): void => {
    const targetPageId = pageId(target);
    const existingIndex = generatedPages.findIndex((page) => page.path === written.page.path);
    if (existingIndex >= 0) {
      generatedPages[existingIndex] = written.page;
    } else {
      generatedPages.push(written.page);
    }
    cacheEntryByPageId.set(targetPageId, written.cacheEntry);

    generatedPages.sort((left, right) =>
      (inputOrderByPageId.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (inputOrderByPageId.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    );
  };

  const checkpointWrittenPage = async (
    target: PageWriteTarget,
    written: WrittenPage,
  ): Promise<void> => {
    upsertWrittenPage(target, written);
    await config.onPageGenerated?.(written.page);
  };

  const persistAndCheckpointWrittenPage = async (
    target: PageWriteTarget,
    written: WrittenPage,
  ): Promise<void> => {
    await mkdir(dirname(written.page.path), { recursive: true });
    await writeFile(written.page.path, written.page.content, "utf-8");
    await checkpointWrittenPage(target, written);
  };

  const removeWrittenPage = (target: PageWriteTarget): void => {
    const fullPath = join(fullOutputDir, target.path);
    const index = generatedPages.findIndex((page) => page.path === fullPath);
    if (index >= 0) generatedPages.splice(index, 1);
    cacheEntryByPageId.delete(pageId(target));
  };

  const maxPageRetries = config.pageFailureMaxRetries ?? DEFAULT_PAGE_FAILURE_MAX_RETRIES;

  const skipFailedPage = (failure: PageGenerationFailure): void => {
    skippedPages.push(failure);
    onProgress?.({
      stage: "writing",
      message: `Skipped failed page: ${failure.title} — ${failure.reason}`,
      progress: totalPages > 0
        ? Math.round((completedCount / totalPages) * 100)
        : 100,
      currentItem: failure.title,
    });
  };

  const writeFailedPageWithUserChoice = async (
    target: PageWriteTarget,
    initialError: unknown,
  ): Promise<void> => {
    // A spend cap or a bad key fails every page the same way: stop the run.
    if (isRunStoppingModelError(initialError)) throw initialError;
    let reason = generationErrorReason(initialError);
    let retryContext = repairContextFromError(initialError, 1);
    let retryCount = 0;

    while (true) {
      const failure = createPageFailure(
        target,
        fullOutputDir,
        reason,
        attemptLimit,
        retryCount,
      );
      failedPages.push(failure);

      const action = await resolvePageFailureAction(config, failure);
      if (action === "abort") {
        throw new PageGenerationAbortedError(
          failure,
          generatedPages,
          skippedPages,
          fullOutputDir,
        );
      }

      if (action === "skip") {
        skipFailedPage(failure);
        return;
      }

      if (!canRetryPageFailure(retryCount, maxPageRetries)) {
        const exhaustedFailure = {
          ...createPageFailure(
            target,
            fullOutputDir,
            `${reason} (page retry budget exhausted after ${retryCount} retries)`,
            attemptLimit,
            retryCount,
          ),
          retryBudgetExhausted: true,
        };
        if (await resolvePageFailureAction(config, exhaustedFailure) === "skip") {
          skipFailedPage(exhaustedFailure);
          return;
        }
        throw new PageGenerationAbortedError(
          exhaustedFailure,
          generatedPages,
          skippedPages,
          fullOutputDir,
        );
      }

      retryCount++;
      const retryProvider = retryCount === maxPageRetries ? fallbackProvider : undefined;
      onProgress?.({
        stage: "writing",
        message: retryProvider
          ? `Retrying failed page: ${failure.title} (retry ${retryCount}, fallback model ${config.writerFallbackModel})`
          : `Retrying failed page: ${failure.title} (retry ${retryCount})`,
        progress: totalPages > 0
          ? Math.round((completedCount / totalPages) * 100)
          : 100,
        currentItem: failure.title,
      });

      try {
        const written = await writePage(target, {
          ...retryContext,
          ...(retryProvider ? { provider: retryProvider } : {}),
        });
        await checkpointWrittenPage(target, written);
        onProgress?.({
          stage: "writing",
          message: `Recovered failed page: ${written.page.title}`,
          progress: totalPages > 0
            ? Math.round((completedCount / totalPages) * 100)
            : 100,
          currentItem: written.page.title,
        });
        return;
      } catch (error) {
        if (isRunStoppingModelError(error)) throw error;
        reason = generationErrorReason(error);
        retryContext = repairContextFromError(error, retryCount + 1);
        console.error(writerFailureLogMessage(pageTitle(target), error));
      }
    }
  };

  // Once a call fails in a way that every call would, no page starts a call.
  let runStoppingError: unknown;
  const pageResults = await mapWithConcurrency(
    pagesToWrite,
    async (target) => {
      const title = pageTitle(target);
      if (runStoppingError !== undefined) {
        throw { target, error: runStoppingError } satisfies FailedPageWrite;
      }
      try {
        const written = await writePage(target);
        await checkpointWrittenPage(target, written);

        completedCount++;
        const reason = docsCheck?.reasons[pageId(target)];
        const reasonSuffix = reason ? ` (${reason})` : "";
        onProgress?.({
          stage: "writing",
          message: `Writing: ${title} (${completedCount}/${totalPages})${reasonSuffix}`,
          progress: Math.round((completedCount / totalPages) * 100),
          currentItem: title,
        });

        return written.page;
      } catch (error) {
        completedCount++;
        if (isRunStoppingModelError(error)) runStoppingError ??= error;
        console.error(writerFailureLogMessage(title, error));
        throw { target, error } satisfies FailedPageWrite;
      }
    },
    {
      concurrency,
      abortController: config.abortController,
      ...(providerCachesPrompts(provider)
        ? { fanOutAfter: firstWriterCall.opened }
        : {}),
    },
  );

  // Failure handling runs one page at a time by default, so interactive
  // prompts follow structure order. Unattended callers raise the width, so
  // failed pages retry in parallel.
  const failedWrites = pageResults.flatMap((result, index): FailedPageWrite[] => {
    if (result.status === "fulfilled") return [];
    if (isFailedPageWrite(result.reason)) return [result.reason];
    const target = pagesToWrite[index];
    return target ? [{ target, error: result.reason }] : [];
  });
  const retryResults = await mapWithConcurrency(
    failedWrites,
    (failed) => writeFailedPageWithUserChoice(failed.target, failed.error),
    {
      concurrency: config.pageRetryConcurrency ?? 1,
      abortController: config.abortController,
    },
  );
  config.abortController?.signal.throwIfAborted();
  const retryFailure = retryResults.find((result) => result.status === "rejected");
  if (retryFailure?.status === "rejected") throw retryFailure.reason;

  // Also include cached pages that weren't regenerated in the result
  if (docsCheck && docsCheck.pagesFromCache.length > 0) {
    const cachedPagesContent = await readExistingPages(
      fullOutputDir,
      allPages.filter((p) => {
        return docsCheck!.pagesFromCache.includes(pageId(p));
      })
    );
    generatedPages.push(...cachedPagesContent);
    await rewriteGeneratedPagesLinks(generatedPages, routeRegistry);
  }

  // A partial run writes a batch of a larger site. When every page of the
  // batch failed, the caller decides from the skipped pages what to do.
  if (generatedPages.length === 0 && !isPartialGeneration) {
    const skippedSummary = skippedPages
      .map((failure) => `${failure.title}: ${failure.reason}`)
      .join("; ");
    throw new Error(
      skippedSummary
        ? `No documentation pages were generated. Skipped pages: ${skippedSummary}`
        : "No documentation pages were generated."
    );
  }

  // Validate the complete docs set before cache/nav persistence. This keeps
  // partial failed runs from looking successful downstream.
  const validatePages = (
    pages: GeneratedPageContent[],
  ): DocsQualityReport =>
    validateGeneratedDocs(pages, {
      outputDir: fullOutputDir,
      structure,
      analysis: normalizedWriterContext?.analysis,
      requireAllStructurePages: !isPartialGeneration,
      ignoredMissingRoutes: Array.from(skippedQualityRoutes),
      failOnWarnings: config.docsQuality?.failOnWarnings,
      routeRegistry,
      allowStructureRoutesForLinks: isPartialGeneration,
    });
  let qualityReport: DocsQualityReport = validatePages(generatedPages);
  let completedQualityRepairs = 0;
  const maxQualityRepairs =
    config.docsQuality?.maxRepairAttempts ?? DEFAULT_DOCS_QUALITY_MAX_REPAIRS;
  const maxQualityRepairsPerPage =
    config.docsQuality?.maxRepairAttemptsPerPage ??
    DEFAULT_DOCS_QUALITY_MAX_REPAIRS_PER_PAGE;

  /**
   * Skips every page that still has blocking issues when no repair budget is
   * left, if the failure handler allows it. Returns false when it does not.
   */
  const skipQualityFailedPages = async (reason: string): Promise<boolean> => {
    const failingTargets = allPages.filter((candidate) =>
      blockingDocsQualityIssues(
        qualityIssuesForTarget(qualityReport, candidate, allPages),
        config.docsQuality?.failOnWarnings === true,
      ).length > 0
    );
    if (failingTargets.length === 0) return false;
    const failures = failingTargets.map((candidate) => {
      const issue = blockingDocsQualityIssues(
        qualityIssuesForTarget(qualityReport, candidate, allPages),
        config.docsQuality?.failOnWarnings === true,
      )[0]!;
      const failure = createQualityFailure(
        candidate,
        fullOutputDir,
        issue,
        attemptLimit,
        qualityRetryCounts.get(pageId(candidate)) ?? 0,
      );
      return {
        target: candidate,
        failure: { ...failure, reason: `${failure.reason} (${reason})`, retryBudgetExhausted: true },
      };
    });
    for (const { failure } of failures) {
      if (await resolveDocsQualityFailureAction(config, failure) !== "skip") return false;
    }
    for (const { target, failure } of failures) {
      failedPages.push(failure);
      skippedPages.push(failure);
      skippedQualityRoutes.add(routeFromTargetPath(target.path));
      removeWrittenPage(target);
    }
    qualityReport = validatePages(generatedPages);
    return true;
  };

  const assessQualityCandidate = (
    job: DocsQualityRepairJob,
    candidate: WrittenPage,
  ) => {
    const candidateReport = validatePages(
      replaceGeneratedPage(generatedPages, candidate.page),
    );
    const candidateIssues = blockingDocsQualityIssues(
      qualityIssuesForTarget(candidateReport, job.target, allPages),
      config.docsQuality?.failOnWarnings === true,
    );
    return assessDocsQualityRepairCandidate(
      job.currentIssues,
      candidateIssues,
      job.repairState.resolvedRules,
    );
  };

  const reportSectionRepairFallback = (
    job: DocsQualityRepairJob,
    reason: string,
  ): void => {
    onProgress?.({
      stage: "writing",
      message:
        `Section repair ${job.pageRepairNumber}/${maxQualityRepairsPerPage}` +
        ` fell back to a whole-page repair for ${pageTitle(job.target)} — ${reason}`,
      progress: 95,
      currentItem: pageTitle(job.target),
    });
  };

  /**
   * Rewrites only the `##` sections that hold the page's blocking issues.
   * Returns undefined, so the caller repairs the whole page, when the
   * issues have no section, the reply or the spliced page fails validation,
   * or the spliced page does not improve docs quality. Template pages and
   * REST endpoint pages always take the whole-page path.
   */
  const repairQualitySectionsOf = async (
    job: DocsQualityRepairJob,
  ): Promise<WrittenPage | undefined> => {
    const page = job.target.page;
    if (deterministicPageRendererFor(page) || isRestEndpointPage(page)) {
      return undefined;
    }
    const writerValidation = config.writerValidation ?? DEFAULT_WRITER_VALIDATION;
    const targetPageId = pageId(job.target);
    const instructions = splicedPageInstructions(normalizedWriterContext, job.currentPage.content);
    let outcome: SectionRepairOutcome;
    try {
      outcome = await withWriterSlot(() => repairQualitySections({
        provider,
        documentationBrief: normalizedWriterContext?.documentationBrief,
        content: job.currentPage.content,
        issues: job.currentIssues,
        resolvedRules: job.repairState.resolvedRules,
        previousRejection: job.repairState.previousRejection,
        routeSummary: routeRegistrySummary(routeRegistry),
        pageId: targetPageId,
        pageTitle: pageTitle(job.target),
        pageRetry: job.pageRepairNumber,
        abortController: config.abortController,
        modelCallTimeoutMs: config.modelCallTimeoutMs,
        modelCallMaxDurationMs: config.modelCallMaxDurationMs,
        onUsage: config.onModelUsage,
        onSpan: config.onSpan,
        validate: (content) =>
          validateSplicedPage(content, writerValidation, config.onSpan, instructions),
      }));
    } catch (error) {
      config.abortController?.signal.throwIfAborted();
      outcome = {
        ok: false,
        stage: "reply",
        reason: generationErrorReason(error),
      };
    }
    if (!outcome.ok) {
      if (outcome.stage !== "plan") {
        reportSectionRepairFallback(job, outcome.reason);
      }
      return undefined;
    }

    const candidate = await toWrittenPage(job.target, {
      content: outcome.content,
      // The splice keeps the rest of the page, so its open issues are found
      // again on the spliced page: instruction breaks and soft content issues.
      openIssues: openIssuesOfShippedPage({
        content: outcome.content,
        rules: instructions?.rules,
        otherIssues: softContentIssuesOfPage(outcome.content),
      }),
      recorded: {
        sourceFilesRead: job.currentPage.dependencies.sourceFilesRead,
        sourceFilesDiscovered: job.currentPage.dependencies.sourceFilesDiscovered,
      },
    }, { persist: false });
    const assessment = assessQualityCandidate(job, candidate);
    if (!assessment.accepted) {
      reportSectionRepairFallback(job, assessment.reason);
      return undefined;
    }
    return candidate;
  };

  const runQualityRepairJob = async (
    job: DocsQualityRepairJob,
  ): Promise<WrittenPage> =>
    await repairQualitySectionsOf(job) ??
      writePage(
        job.target,
        {
          initialRetryHint: job.retryHint,
          pageRetry: job.pageRepairNumber,
        },
        { persist: false },
      );

  while (config.docsQuality?.enabled !== false && !qualityReport.ok) {
    if (!canRunDocsQualityRepair(
      completedQualityRepairs,
      maxQualityRepairs,
    )) {
      if (await skipQualityFailedPages("quality repair budget exhausted")) continue;
      throw new DocsQualityValidationError(
        `Generated docs exhausted the quality repair budget after ${completedQualityRepairs} repairs: ${formatDocsQualityIssues(qualityReport)}`,
      );
    }

    const issue =
      qualityReport.issues.find((issue) => issue.severity === "error") ??
      qualityReport.issues[0];
    const target = issue
      ? findTargetForQualityIssue(issue, allPages)
      : undefined;
    if (!issue || !target) {
      throw new DocsQualityValidationError(
        `Generated docs failed quality validation: ${formatDocsQualityIssues(qualityReport)}`,
      );
    }

    const remainingRepairBudget =
      maxQualityRepairs - completedQualityRepairs;
    const repairTargets = allPages.filter((candidateTarget) => {
      const candidateIssues = blockingDocsQualityIssues(
        qualityIssuesForTarget(qualityReport, candidateTarget, allPages),
        config.docsQuality?.failOnWarnings === true,
      );
      if (candidateIssues.length === 0) return false;
      const retryCount = qualityRetryCounts.get(pageId(candidateTarget)) ?? 0;
      return canRunDocsQualityRepairForPage(
        retryCount,
        maxQualityRepairsPerPage,
      );
    });

    if (repairTargets.length === 0) {
      if (await skipQualityFailedPages("quality repair budget exhausted for this page")) continue;
      const targetPageId = pageId(target);
      const retryCount = qualityRetryCounts.get(targetPageId) ?? 0;
      const budgetFailure = createQualityFailure(
        target,
        fullOutputDir,
        issue,
        attemptLimit,
        retryCount,
      );
      const exhaustedFailure = {
        ...budgetFailure,
        reason:
          `${budgetFailure.reason} (quality repair budget exhausted after ${retryCount} repairs for this page)`,
      };
      failedPages.push(exhaustedFailure);
      throw new PageGenerationAbortedError(
        exhaustedFailure,
        generatedPages,
        skippedPages,
        fullOutputDir,
      );
    }

    const repairJobs: DocsQualityRepairJob[] = [];
    for (const repairTarget of repairTargets) {
      if (repairJobs.length >= remainingRepairBudget) break;

      const targetPageId = pageId(repairTarget);
      const retryCount = qualityRetryCounts.get(targetPageId) ?? 0;
      const repairState = qualityRepairStateByPageId.get(targetPageId) ?? {
        resolvedRules: new Set<string>(),
      };
      qualityRepairStateByPageId.set(targetPageId, repairState);
      const currentIssues = blockingDocsQualityIssues(
        qualityIssuesForTarget(qualityReport, repairTarget, allPages),
        config.docsQuality?.failOnWarnings === true,
      );
      const targetIssue = currentIssues[0];
      if (!targetIssue) continue;

      const failure = createQualityFailure(
        repairTarget,
        fullOutputDir,
        targetIssue,
        attemptLimit,
        retryCount,
      );
      failedPages.push(failure);
      const action = await resolveDocsQualityFailureAction(config, failure);
      if (action === "abort") {
        throw new PageGenerationAbortedError(
          failure,
          generatedPages,
          skippedPages,
          fullOutputDir,
        );
      }

      if (action === "skip") {
        skippedPages.push(failure);
        skippedQualityRoutes.add(routeFromTargetPath(repairTarget.path));
        removeWrittenPage(repairTarget);
        onProgress?.({
          stage: "writing",
          message:
            `Skipped quality-failed page: ${failure.title} — ${failure.reason}`,
          progress: 95,
          currentItem: failure.title,
        });
        continue;
      }

      const pageRepairNumber = retryCount + 1;
      const globalRepairNumber =
        completedQualityRepairs + repairJobs.length + 1;
      const currentPage = generatedPages.find(
        (page) => page.id === targetPageId,
      );
      if (!currentPage || currentIssues.length === 0) {
        throw new DocsQualityValidationError(
          `Cannot repair ${failure.title} because its accepted draft or blocking issues are unavailable.`,
        );
      }
      qualityRetryCounts.set(targetPageId, pageRepairNumber);
      onProgress?.({
        stage: "writing",
        message:
          `Quality repair ${pageRepairNumber}/${maxQualityRepairsPerPage} for ${failure.title}` +
          ` — global repair ${globalRepairNumber}/${maxQualityRepairs}; rule: ${targetIssue.rule}`,
        progress: 95,
        currentItem: failure.title,
      });

      repairJobs.push({
        target: repairTarget,
        pageRepairNumber,
        currentPage,
        currentIssues,
        repairState,
        retryHint: buildDocsQualityRepairFeedback({
          currentDraft: stripRestEndpointReferenceBlock(currentPage.content),
          currentIssues,
          resolvedRules: repairState.resolvedRules,
          previousRejection: repairState.previousRejection,
        }),
      });
    }

    const candidateResults = await mapWithConcurrency(
      repairJobs,
      runQualityRepairJob,
      {
        concurrency,
        abortController: config.abortController,
      },
    );
    completedQualityRepairs += repairJobs.length;

    for (const [index, candidateResult] of candidateResults.entries()) {
      const job = repairJobs[index];
      if (!job) continue;

      if (candidateResult.status === "rejected") {
        const error = candidateResult.reason;
        const rejectionReason = error instanceof PageValidationExhaustedError
          ? `writer validation failed: ${generationErrorReason(error)}`
          : `candidate generation failed: ${generationErrorReason(error)}`;
        job.repairState.previousRejection = {
          reason: rejectionReason,
          candidateRules: [],
        };
        onProgress?.({
          stage: "writing",
          message:
            `Quality repair candidate ${job.pageRepairNumber}/${maxQualityRepairsPerPage}` +
            ` rejected for ${pageTitle(job.target)} — ${rejectionReason}`,
          progress: 95,
          currentItem: pageTitle(job.target),
        });
        continue;
      }

      const candidate = candidateResult.value;
      const assessment = assessQualityCandidate(job, candidate);

      if (assessment.accepted) {
        for (const resolvedRule of assessment.resolvedRules) {
          job.repairState.resolvedRules.add(resolvedRule);
        }
        job.repairState.previousRejection = undefined;
        await persistAndCheckpointWrittenPage(job.target, candidate);
      } else {
        job.repairState.previousRejection = {
          reason: assessment.reason,
          candidateRules: assessment.candidateRules,
        };
        onProgress?.({
          stage: "writing",
          message:
            `Quality repair candidate ${job.pageRepairNumber}/${maxQualityRepairsPerPage}` +
            ` rejected for ${pageTitle(job.target)} — ${assessment.reason}`,
          progress: 95,
          currentItem: pageTitle(job.target),
        });
      }
    }

    qualityReport = validatePages(generatedPages);
  }

  // Save docs cache manifest
  if (cacheManager && !isPartialGeneration) {
    cachedPageEntries.length = 0;
    cachedPageEntries.push(...cacheEntryByPageId.values());
    const structureHash = hashObject(structure);
    const analysisHash = writerAnalysisHash(normalizedWriterContext);

    if (docsCheck && docsCheck.pagesFromCache.length > 0) {
      // Incremental update — merge new entries with existing cached ones
      await cacheManager.updateDocPages(cachedPageEntries, structureHash, analysisHash, allPageIds);
    } else {
      // Full generation — save all entries
      await cacheManager.saveDocs(cachedPageEntries, structureHash, analysisHash);
    }
  }

  if (execution.finalize !== false) {
    await pruneStaleMarkdownFiles(fullOutputDir, generatedPages);
  }

  // Order the generated docs for ideal reader flow and persist a manifest
  // that downstream commands (e.g. `website`) read when building nav.
  if (execution.finalize !== false) {
    try {
      await orderAndPersistNav({
        provider,
        pages: generatedPages,
        structure,
        fullOutputDir,
        cwd: config.cwd,
        onProgress,
        promptRegistry,
        abortController: config.abortController,
        analysis: normalizedWriterContext?.analysis,
        documentationBrief: normalizedWriterContext?.documentationBrief,
        onModelUsage: config.onModelUsage,
        modelCallTimeoutMs: config.modelCallTimeoutMs,
        modelCallMaxDurationMs: config.modelCallMaxDurationMs,
      });
    } catch (error) {
      config.abortController?.signal.throwIfAborted();
      const message = error instanceof Error ? error.message : "Unknown ordering error";
      onProgress?.({
        stage: "ordering",
        message: `Ordering pass skipped: ${message}`,
        progress: 95,
      });
    }
  }

  onProgress?.({
    stage: "complete",
    message: `Generated ${generatedPages.length} documentation pages${docsCheck ? ` (${docsCheck.pagesFromCache.length} from cache)` : ""}${skippedPages.length > 0 ? `, skipped ${skippedPages.length} failed page(s)` : ""}`,
    progress: 100,
  });

  return {
    pages: generatedPages,
    totalPages: generatedPages.length,
    outputDir: fullOutputDir,
    failedPages,
    skippedPages,
    qualityReport,
  };
}

/**
 * Generate only the top N most complex pages from a documentation structure.
 * Used for quick internal testing of doc quality without full generation.
 * Skips caching entirely and writes to a test-specific output dir.
 */
export async function generateTestPages(
  config: AgentConfig,
  structure: DocumentationStructure,
  onProgress?: AgentProgressCallback,
  writerContext?: WriterContext,
  count: number = 3,
  providerOverride?: Provider
): Promise<GenerationResult> {
  const outputDir = config.outputDir || ".doxa/test-docs";
  const artifactRoot = config.artifactRoot ?? config.cwd;
  const fullOutputDir = await resolveProjectPath(artifactRoot, outputDir);
  await mkdir(fullOutputDir, { recursive: true });

  const provider = providerOverride ?? createProviderFromConfig(config);
  const promptRegistry = resolvePromptRegistry(config);
  const writerMaxSteps = resolveWriterMaxSteps(config.writerMaxSteps);
  const normalizedWriterContext = writerContext
    ? { ...writerContext, analysis: normalizeProjectAnalysis(writerContext.analysis) }
    : undefined;

  onProgress?.({ stage: "gathering", message: "Ranking pages by complexity...", progress: 0 });

  // Flatten and score all pages
  const allPages = flattenStructure(structure);
  const routeRegistry = buildRouteRegistry(structure);

  // Complexity scoring: higher = more complex/interesting to test
  const PAGE_TYPE_COMPLEXITY: Record<PageType, number> = {
    "architecture": 10,
    "api-reference": 9,
    "rest-api-reference": 9,
    "rest-api-overview": 5,
    "rest-api-auth": 7,
    "rest-api-group": 6,
    "sdk-api-reference": 9,
    "configuration": 8,
    "guide": 7,
    "concept": 6,
    "cli-reference": 5,
    "provider": 5,
    "getting-started": 3,
    "overview": 2,
    "general": 4,
  };

  const scored = allPages.map((p) => {
    const title = p.page.title;
    const description = p.page.description;
    const pageType = detectPageType(p.sectionTitle, title, p.page);

    let score = PAGE_TYPE_COMPLEXITY[pageType] || 4;

    // Bonus for longer descriptions (more content to cover)
    score += Math.min(description.length / 50, 3);

    // Bonus for keywords suggesting complexity
    const lower = title.toLowerCase();
    if (lower.includes("advanced")) score += 2;
    if (lower.includes("api")) score += 1;
    if (lower.includes("architecture")) score += 1;
    if (lower.includes("migration")) score += 1;
    if (lower.includes("deploy")) score += 1;
    if (lower.includes("security")) score += 1;
    if (lower.includes("auth")) score += 1;

    return { ...p, score, pageType };
  });

  // Sort by score descending and take top N, ensuring type diversity
  scored.sort((a, b) => b.score - a.score);

  const selected: typeof scored = [];
  const seenTypes = new Set<string>();

  // First pass: pick highest-scoring page from each unique type
  for (const page of scored) {
    if (selected.length >= count) break;
    if (!seenTypes.has(page.pageType)) {
      selected.push(page);
      seenTypes.add(page.pageType);
    }
  }

  // Second pass: fill remaining slots with highest-scoring pages
  if (selected.length < count) {
    for (const page of scored) {
      if (selected.length >= count) break;
      if (!selected.includes(page)) {
        selected.push(page);
      }
    }
  }

  const selectedTitles = selected.map((p) => {
    const t = p.page.title;
    return `${t} (${p.pageType}, score: ${p.score.toFixed(1)})`;
  });

  onProgress?.({
    stage: "writing",
    message: `Selected ${selected.length} pages for test:\n  ${selectedTitles.join("\n  ")}`,
    progress: 5,
  });

  // Load component playbook
  const componentPlaybook = config.componentPlaybook;

  const generatedPages: GeneratedPageContent[] = [];
  const failedPages: TestPageFailure[] = [];
  let completedCount = 0;
  const totalPages = selected.length;

  // Write pages sequentially for cleaner test output
  for (const target of selected) {
    const { sectionTitle, page, path, pageType, score } = target;
    const title = page.title;
    const id = pageId(target);

    completedCount++;
    onProgress?.({
      stage: "writing",
      message: `[${completedCount}/${totalPages}] Writing: ${title} (${pageType}, complexity: ${score.toFixed(1)})`,
      progress: Math.round((completedCount / totalPages) * 90),
      currentItem: title,
    });

    try {
      const renderer = deterministicPageRendererFor(page);
      const rawContent = renderer
        ? await renderer.render({
          pageId: id,
          page,
          writerContext: normalizedWriterContext,
          writerValidation: config.writerValidation ?? DEFAULT_WRITER_VALIDATION,
          promptRegistry,
          onSpan: config.onSpan,
        })
        : await writeDocPage(
          provider,
          config.cwd,
          sectionTitle,
          id,
          page,
          normalizedWriterContext,
          componentPlaybook,
          config.writerValidation ?? DEFAULT_WRITER_VALIDATION,
          promptRegistry,
          config.abortController,
          undefined,
          undefined,
          0,
          artifactRoot,
          config.onWriterDiagnostic,
          config.onModelUsage,
          config.onRepairDiagnostic,
          config.onSpan,
          config.writerExploration,
          undefined,
          config.modelCallTimeoutMs,
          config.modelCallMaxDurationMs,
          writerMaxSteps,
        );
      const content = rewriteInternalLinks(rawContent, routeRegistry);

      const fullPath = await resolveProjectPath(fullOutputDir, path);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, "utf-8");

      generatedPages.push({
        id,
        path: fullPath,
        title,
        content,
        dependencies: emptyPageDependencyState(),
        contentHash: hashString(content),
        pageInputHash: hashObject({
          id,
          path,
          title,
        }),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failedPages.push({ title, reason });
      console.error(`Failed to write test page "${title}": ${reason}`);
    }
  }

  if (failedPages.length > 0) {
    onProgress?.({
      stage: "error",
      message: `Failed ${failedPages.length}/${totalPages} selected test page(s): ${failedPages.map((failure) => failure.title).join(", ")}`,
      progress: 100,
    });
    throw new TestPageGenerationError(failedPages, generatedPages, fullOutputDir);
  }

  const qualityReport = validateGeneratedDocs(generatedPages, {
    outputDir: fullOutputDir,
    structure,
    analysis: normalizedWriterContext?.analysis,
    requireAllStructurePages: false,
    failOnWarnings: config.docsQuality?.failOnWarnings,
    routeRegistry,
    allowStructureRoutesForLinks: true,
  });

  if (config.docsQuality?.enabled !== false && !qualityReport.ok) {
    onProgress?.({
      stage: "error",
      message: `Selected test pages failed docs quality validation: ${qualityReport.issues.map((issue) => issue.rule).join(", ")}`,
      progress: 100,
    });
    throw new TestPageGenerationError(
      qualityReport.issues.map((issue) => ({
        title: issue.title ?? issue.route ?? "Generated docs",
        reason: `${issue.rule}: ${issue.message}${issue.excerpt ? ` (${issue.excerpt})` : ""}`,
      })),
      generatedPages,
      fullOutputDir,
    );
  }

  // Order the selected pages for ideal reader flow and persist a manifest.
  // The dev harness's materializer reads this when wiring up the template's
  // documents.json, so without it the nav falls back to insertion order.
  try {
    await orderAndPersistNav({
      provider,
      pages: generatedPages,
      structure,
      fullOutputDir,
      cwd: config.cwd,
      onProgress,
      promptRegistry,
      abortController: config.abortController,
      analysis: normalizedWriterContext?.analysis,
      documentationBrief: normalizedWriterContext?.documentationBrief,
      onModelUsage: config.onModelUsage,
      modelCallTimeoutMs: config.modelCallTimeoutMs,
      modelCallMaxDurationMs: config.modelCallMaxDurationMs,
    });
  } catch (error) {
    config.abortController?.signal.throwIfAborted();
    const message = error instanceof Error ? error.message : "Unknown ordering error";
    onProgress?.({
      stage: "ordering",
      message: `Ordering pass skipped: ${message}`,
      progress: 95,
    });
  }

  onProgress?.({
    stage: "complete",
    message: `Test generation complete: ${generatedPages.length}/${totalPages} pages written`,
    progress: 100,
  });

  return {
    pages: generatedPages,
    totalPages: generatedPages.length,
    outputDir: fullOutputDir,
    failedPages: [],
    skippedPages: [],
    qualityReport,
  };
}
