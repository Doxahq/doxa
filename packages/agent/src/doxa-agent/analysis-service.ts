import type { AgentConfig, AgentProgressCallback, DocumentationStructure, ProjectAnalysis, StructureSuggestionInput } from "../types";
import { normalizeProjectAnalysis } from "../utils/analysis-normalizer";
import {
  discoverDocumentationCollections,
  mergeDocumentationCollections,
} from "../utils/documentation-collections";
import type { AgentCacheManager, SourceChangeSet } from "../cache";
import { createProviderFromConfig } from "./provider-factory";
import { exploreProject, generateAnalysisWithRetry, runIncrementalAnalysis } from "./analysis-runner";
import { generateStructureWithRetry } from "./structure-runner";
import { prompts } from "./prompts";
import type { PromptRegistry } from "./prompts";
import { documentationBriefFingerprint, resolveDocumentationBrief } from "./documentation-policy";
import { filterPublicReferenceSurfaces } from "./public-surfaces";
import { resolvePlanningRepoMap } from "./planning-repo-map";
import { loadRepositoryAgentNotes, renderRepositoryAgentNotesBlock } from "./repository-agent-notes";
import { readRepositorySpecs, type RepositorySpecRead } from "../reference-specs/reader";
import { withRestSurface } from "../utils/analysis-rest-surface";
import { extractRestReference } from "../rest-extraction";
import type { RestReferencePromptMode } from "./prompts/dynamic";

export interface ProjectAnalysisWithCacheState {
  analysis: ProjectAnalysis;
  sourceChanges: SourceChangeSet;
}

export interface AnalysisCacheStateOptions {
  sourceChanges?: SourceChangeSet;
}

type AgentConfigWithInternalPrompts = AgentConfig & {
  promptRegistry?: PromptRegistry;
};

const BRIEF_FINGERPRINT_CACHE_KEY = "__doxaDocumentationBriefFingerprint";

function cachedBriefFingerprint(analysis: Record<string, unknown> | null): string | undefined {
  const value = analysis?.[BRIEF_FINGERPRINT_CACHE_KEY];
  return typeof value === "string" ? value : undefined;
}

function analysisForCache(
  analysis: ProjectAnalysis,
  briefFingerprint: string,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(analysis)) record[key] = value;
  record[BRIEF_FINGERPRINT_CACHE_KEY] = briefFingerprint;
  return record;
}

function resolvePromptRegistry(config: AgentConfig): PromptRegistry {
  return (config as AgentConfigWithInternalPrompts).promptRegistry ?? prompts;
}

function sourceChangesFromCacheCheck(cacheCheck: {
  changedFiles: string[];
  addedFiles: string[];
  deletedFiles: string[];
}): SourceChangeSet {
  return {
    changedFiles: cacheCheck.changedFiles,
    addedFiles: cacheCheck.addedFiles,
    deletedFiles: cacheCheck.deletedFiles,
  };
}

/**
 * Adds what code finds to an analysis: the REST surface of the spec files,
 * which replaces the REST surface of the model, the source report, and the
 * documentation collections. It runs on every analysis path, cached or not.
 */
async function enrichAnalysis(
  config: AgentConfig,
  analysis: ProjectAnalysis,
  specRead: RepositorySpecRead,
): Promise<ProjectAnalysis> {
  const discovered = await discoverDocumentationCollections(config.cwd);
  return filterPublicReferenceSurfaces(
    mergeDocumentationCollections(normalizeProjectAnalysis(withRestReference(analysis, specRead)), discovered),
  );
}

/** The analysis with the REST surface of the spec files, when they gave one, and the source report. */
function withRestReference(analysis: ProjectAnalysis, specRead: RepositorySpecRead): ProjectAnalysis {
  const withSurface = specRead.surface ? withRestSurface(analysis, specRead.surface) : analysis;
  return { ...withSurface, referenceSourceReport: specRead.report };
}

/** How the prompts treat the REST reference: spec files, file-by-file extraction, or the answer. */
function restReferencePromptMode(config: AgentConfig, specRead: RepositorySpecRead): RestReferencePromptMode {
  const specFiles = specRead.surface?.source?.files;
  if (specFiles?.length) return { specFiles };
  return config.restExtractionModel ? { endpointExtraction: true } : {};
}

/**
 * The model route extracts the endpoints file by file when it is on. The
 * spec route needs no extraction: its surface replaces the model surface.
 */
function withExtractedEndpoints(
  config: AgentConfig,
  analysis: ProjectAnalysis,
  specRead: RepositorySpecRead,
  options: Parameters<typeof extractRestReference>[2] = {},
): Promise<ProjectAnalysis> {
  return specRead.surface ? Promise.resolve(analysis) : extractRestReference(config, analysis, options);
}

/**
 * Analyze a project with smart caching.
 *
 * - No cache: Full exploration + analysis (20+ AI tool calls)
 * - Cache hit, no changes: Returns cached analysis instantly (0 tokens)
 * - Cache hit, files changed: Incremental update (1 AI call vs 20+)
 */
export async function analyzeProjectOnly(
  config: AgentConfig,
  onProgress?: AgentProgressCallback,
  cacheManager?: AgentCacheManager
): Promise<ProjectAnalysis> {
  const result = await analyzeProjectWithCacheState(config, onProgress, cacheManager);
  return result.analysis;
}

/**
 * Analyze a project and return the source changes captured before any analysis
 * cache write mutates the analysis reference commit.
 */
export async function analyzeProjectWithCacheState(
  config: AgentConfig,
  onProgress?: AgentProgressCallback,
  cacheManager?: AgentCacheManager,
  options: AnalysisCacheStateOptions = {},
): Promise<ProjectAnalysisWithCacheState> {
  onProgress?.({ stage: "analyzing", message: "Starting project analysis...", progress: 0 });

  const provider = createProviderFromConfig(config);
  const promptRegistry = resolvePromptRegistry(config);
  const documentationBrief = resolveDocumentationBrief(config.documentationBrief);
  const briefFingerprint = documentationBriefFingerprint(documentationBrief);
  const emptySourceChanges: SourceChangeSet = {
    changedFiles: [],
    addedFiles: [],
    deletedFiles: [],
  };

  try {
    onProgress?.({ stage: "analyzing", message: "Reading API spec files...", progress: 2 });
    const specRead = await readRepositorySpecs({
      checkoutRoot: config.cwd,
      client: config.specReader,
      configuredPaths: config.restApiSpecPaths,
    });

    // Check cache if available
    if (cacheManager) {
      const cacheCheck = await cacheManager.checkAnalysis(options.sourceChanges);
      const briefChanged = cachedBriefFingerprint(cacheCheck.cachedAnalysis) !== briefFingerprint;

      // Cache hit — no changes
      if (!briefChanged && !cacheCheck.needsReanalysis && cacheCheck.cachedAnalysis) {
        onProgress?.({
          stage: "analyzing",
          message: `Using cached analysis (no changes since ${cacheCheck.currentCommitHash.slice(0, 7)})`,
          progress: 100,
        });
        const analysis = await enrichAnalysis(
          config,
          normalizeProjectAnalysis(cacheCheck.cachedAnalysis),
          specRead,
        );
        return {
          analysis,
          sourceChanges: sourceChangesFromCacheCheck(cacheCheck),
        };
      }

      // Cache hit with changes — incremental update
      if (!briefChanged && cacheCheck.cachedAnalysis && cacheCheck.cachedExplorationContext) {
        const allChanges = [
          ...cacheCheck.changedFiles,
          ...cacheCheck.addedFiles,
        ];
        const deletions = cacheCheck.deletedFiles;

        onProgress?.({
          stage: "analyzing",
          message: `${allChanges.length} file(s) changed, ${deletions.length} deleted — running incremental analysis...`,
          progress: 10,
        });

        const result = await runIncrementalAnalysis(
          provider,
          config,
          cacheCheck,
          onProgress,
          promptRegistry,
        );
        const withEndpoints = await withExtractedEndpoints(config, result, specRead, {
          previous: normalizeProjectAnalysis(cacheCheck.cachedAnalysis),
          changedPaths: new Set([...allChanges, ...deletions]),
          onProgress,
        });

        // Save updated analysis to cache
        onProgress?.({ stage: "analyzing", message: "Saving analysis to cache...", progress: 95 });
        const analysis = await enrichAnalysis(config, withEndpoints, specRead);
        await cacheManager.saveAnalysis(
          analysisForCache(analysis, briefFingerprint),
          cacheCheck.cachedExplorationContext
        );

        onProgress?.({ stage: "analyzing", message: "Incremental analysis complete", progress: 100 });
        return {
          analysis,
          sourceChanges: sourceChangesFromCacheCheck(cacheCheck),
        };
      }
    }

    // No cache or full analysis needed
    onProgress?.({ stage: "analyzing", message: "Exploring codebase...", progress: 10 });

    const repoMap = await resolvePlanningRepoMap(config, onProgress);
    const restReference = restReferencePromptMode(config, specRead);
    const repositoryAgentNotes = await readRepositoryAgentNotes(config.cwd, onProgress);
    const explorationContext = await exploreProject(
      provider,
      config,
      onProgress,
      promptRegistry,
      repoMap,
      restReference,
      repositoryAgentNotes,
    );

    onProgress?.({ stage: "analyzing", message: "Generating project analysis...", progress: 70 });

    const modelAnalysis = normalizeProjectAnalysis(await generateAnalysisWithRetry(
      provider,
      explorationContext,
      onProgress,
      1,
      promptRegistry,
      config.abortController,
      documentationBrief,
      config.onModelUsage,
      config.onSpan,
      config.modelCallTimeoutMs,
      config.modelCallMaxDurationMs,
      repoMap,
      restReference,
      repositoryAgentNotes,
    ));
    const result = await enrichAnalysis(
      config,
      await withExtractedEndpoints(config, modelAnalysis, specRead, { onProgress }),
      specRead,
    );

    // Save to cache if available
    if (cacheManager) {
      onProgress?.({ stage: "analyzing", message: "Saving analysis to cache...", progress: 95 });
      await cacheManager.saveAnalysis(
        analysisForCache(result, briefFingerprint),
        explorationContext
      );
    }

    onProgress?.({ stage: "analyzing", message: "Analysis complete", progress: 100 });
    return {
      analysis: result,
      sourceChanges: emptySourceChanges,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    onProgress?.({ stage: "error", message: `Analysis failed: ${errorMessage}`, progress: 0 });
    throw error;
  }
}

/**
 * Suggest documentation structure based on analysis + user answers.
 */
export async function suggestStructure(
  config: AgentConfig,
  input: StructureSuggestionInput,
  onProgress?: AgentProgressCallback,
  _cacheManager?: AgentCacheManager
): Promise<DocumentationStructure> {
  onProgress?.({ stage: "proposing", message: "Generating documentation structure...", progress: 0 });

  const provider = createProviderFromConfig(config);
  const promptRegistry = resolvePromptRegistry(config);
  const normalizedInput: StructureSuggestionInput = {
    ...input,
    analysis: normalizeProjectAnalysis(input.analysis),
    documentationBrief: input.documentationBrief ?? resolveDocumentationBrief(config.documentationBrief),
    initialValidationErrors: input.initialValidationErrors?.filter((error) => error.trim().length > 0),
  };

  try {
    const structure = await generateStructureWithRetry(
      provider,
      normalizedInput,
      onProgress,
      1,
      normalizedInput.initialValidationErrors ?? [],
      promptRegistry,
      config.abortController,
      config.onModelUsage,
      config.onSpan,
      config.modelCallTimeoutMs,
      config.modelCallMaxDurationMs,
    );
    onProgress?.({ stage: "proposing", message: "Documentation structure ready", progress: 100 });
    return structure;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    onProgress?.({ stage: "error", message: `Structure suggestion failed: ${errorMessage}`, progress: 0 });
    throw error;
  }
}

/**
 * Reads the repository's agent notes first, as a fast route to the facts.
 * Missing or broken files are skipped, so this never stops the analysis.
 */
async function readRepositoryAgentNotes(
  projectRoot: string,
  onProgress?: AgentProgressCallback,
): Promise<string | undefined> {
  const agentNotes = await loadRepositoryAgentNotes(projectRoot);
  if (agentNotes.notes.length > 0 || agentNotes.skipped.length > 0) {
    const skipped = agentNotes.skipped.map((file) => `${file.path} (${file.reason})`).join(", ");
    onProgress?.({
      stage: "analyzing",
      message: `Read ${agentNotes.notes.length} agent note file(s)${skipped ? `; skipped ${skipped}` : ""}.`,
      progress: 10,
    });
  }
  return renderRepositoryAgentNotesBlock(agentNotes);
}
