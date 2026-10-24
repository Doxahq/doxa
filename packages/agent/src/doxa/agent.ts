import type { AgentProgressEvent, DocumentationStructure, GenerationResult, ProjectAnalysis } from "../types";
import { EMPTY_SOURCE_CHANGES, hasSourceChanges } from "../state/source-changes";
import {
  createDocsPlanningContext,
  planDocsGeneration,
} from "../state/planning";
import type { SourceChangeSet } from "../state/types";
import { materializeWrittenPage, mergeManifestPages, readCachedPage } from "./artifact-materializer";
import { validateGeneratedPages } from "./quality-validator";
import type {
  AnalyzeProjectOptions,
  DoxaAgent,
  DoxaAgentConfig,
  GenerateDocsOptions,
  SuggestStructureOptions,
  UpdateDocsOptions,
} from "./types";

export function createDoxaAgent(config: DoxaAgentConfig): DoxaAgent {
  return new DoxaAgentRuntime(config);
}

class DoxaAgentRuntime implements DoxaAgent {
  constructor(private readonly config: DoxaAgentConfig) {}

  async analyzeProject(options: AnalyzeProjectOptions = {}): Promise<ProjectAnalysis> {
    this.emitProgress({ stage: "analyzing", message: "Checking analysis state...", progress: 0 });
    const previousAnalysis = await this.config.state.loadAnalysisState();
    const sourceChanges = await this.resolveSourceChanges(options.sourceChanges);

    if (!options.force && previousAnalysis && !hasSourceChanges(sourceChanges)) {
      this.emitProgress({ stage: "analyzing", message: "Using cached analysis", progress: 100 });
      return previousAnalysis.analysis;
    }

    const analyzeProject = this.config.handlers?.analyzeProject;
    if (!analyzeProject) {
      throw new Error("No analyzeProject handler configured for @doxahq/agent.");
    }

    const result = await analyzeProject({
      workspace: this.config.workspace,
      previousAnalysis,
      sourceChanges,
    });
    const checkpoint = await this.config.workspace.createCheckpoint?.() ?? await this.config.state.loadCheckpoint();

    await this.config.state.saveAnalysisState({
      analysis: result.analysis,
      explorationContext: result.explorationContext,
      sourceCheckpoint: checkpoint,
      updatedAt: new Date().toISOString(),
    });
    if (checkpoint) await this.config.state.saveCheckpoint(checkpoint);

    this.emitProgress({ stage: "analyzing", message: "Analysis complete", progress: 100 });
    return result.analysis;
  }

  async suggestStructure(options: SuggestStructureOptions): Promise<DocumentationStructure> {
    const previousStructure = await this.config.state.loadStructure();
    if (!options.force && previousStructure) return previousStructure;

    const analysis = options.analysis ?? (await this.config.state.loadAnalysisState())?.analysis;
    if (!analysis) throw new Error("Cannot suggest structure without project analysis.");

    const suggestStructure = this.config.handlers?.suggestStructure;
    if (!suggestStructure) {
      throw new Error("No suggestStructure handler configured for @doxahq/agent.");
    }

    this.emitProgress({ stage: "proposing", message: "Suggesting documentation structure...", progress: 0 });
    const structure = await suggestStructure({
      analysis,
      answers: options.answers,
      previousStructure,
    });
    await this.config.state.saveStructure(structure);
    this.emitProgress({ stage: "proposing", message: "Documentation structure ready", progress: 100 });
    return structure;
  }

  async generateDocs(options: GenerateDocsOptions = {}): Promise<GenerationResult> {
    const structure = options.structure ?? await this.config.state.loadStructure();
    if (!structure) throw new Error("Cannot generate docs without a documentation structure.");

    const analysis = options.analysis ?? (await this.config.state.loadAnalysisState())?.analysis ?? null;
    const context = await createDocsPlanningContext({
      structure,
      analysis,
      documentationBrief: options.writerContext?.documentationBrief,
    });
    const previousManifest = await this.config.state.loadDocsManifest();
    const sourceChanges = await this.resolveSourceChanges(options.sourceChanges);
    const plan = planDocsGeneration({
      allPageIds: context.allPageIds,
      pageInputHashes: context.pageInputHashes,
      previousManifest,
      sourceChanges,
      force: options.force,
      currentAnalysisHash: context.analysisHash,
    });

    this.emitProgress({
      stage: "gathering",
      message: plan.needsGeneration
        ? `Generating ${plan.pagesToGenerate.length} page(s), using ${plan.pagesFromCache.length} cached page(s)`
        : "All pages are up to date",
      progress: 5,
    });

    const writePage = this.config.handlers?.writePage;
    if (plan.pagesToGenerate.length > 0 && !writePage) {
      throw new Error("No writePage handler configured for @doxahq/agent.");
    }

    const targetById = new Map(context.targets.map((target) => [target.pageId, target]));
    const pages = [];
    const updatedEntries = [];
    let completed = 0;

    for (const pageId of plan.pagesToGenerate) {
      const target = targetById.get(pageId);
      if (!target || !writePage) continue;
      const written = await writePage({
        target,
        workspace: this.config.workspace,
        writerContext: options.writerContext,
      });
      const materialized = await materializeWrittenPage({
        artifacts: this.config.artifacts,
        target,
        writerResult: written,
        pageInputHash: context.pageInputHashes[pageId],
      });
      pages.push(materialized.page);
      updatedEntries.push(materialized.cacheEntry);
      completed++;
      this.emitProgress({
        stage: "writing",
        message: `Wrote ${target.title}`,
        progress: Math.round((completed / Math.max(1, plan.pagesToGenerate.length)) * 100),
        currentItem: target.title,
      });
    }

    for (const pageId of plan.pagesFromCache) {
      const target = targetById.get(pageId);
      if (!target) continue;
      const cacheEntry = previousManifest?.pages.find(
        (page) => page.pageId === pageId,
      );
      const cached = await readCachedPage({
        artifacts: this.config.artifacts,
        target,
        cacheEntry,
      });
      if (cached) pages.push(cached);
    }

    const manifest = mergeManifestPages({
      previousManifest,
      updatedEntries,
      activePageIds: context.allPageIds,
      structureHash: context.structureHash,
      analysisHash: context.analysisHash,
    });
    await this.config.state.saveDocsManifest(manifest);
    await this.config.artifacts.prune?.(context.targets.map((target) => target.outputPath), options.outputPrefix);

    const checkpoint = await this.config.workspace.createCheckpoint?.();
    if (checkpoint) await this.config.state.saveCheckpoint(checkpoint);

    const qualityReport = validateGeneratedPages(pages);
    this.emitProgress({ stage: "complete", message: "Documentation generation complete", progress: 100 });

    return {
      pages: pages.sort((a, b) => a.path.localeCompare(b.path)),
      totalPages: context.targets.length,
      outputDir: options.outputPrefix ?? "",
      failedPages: [],
      skippedPages: [],
      qualityReport,
    };
  }

  async updateDocs(options: UpdateDocsOptions = {}): Promise<GenerationResult> {
    const analysis = await this.analyzeProject({
      sourceChanges: options.sourceChanges,
      force: options.force,
    });
    const structure = await this.suggestStructure({
      analysis,
      answers: options.answers ?? {},
      force: options.refreshStructure,
    });
    return this.generateDocs({
      analysis,
      structure,
      sourceChanges: options.sourceChanges,
      force: options.force,
      writerContext: {
        analysis,
        answers: options.answers ?? {},
        structure,
      },
    });
  }

  private async resolveSourceChanges(explicitChanges?: SourceChangeSet): Promise<SourceChangeSet> {
    if (explicitChanges) return explicitChanges;
    const checkpoint = await this.config.state.loadCheckpoint();
    return await this.config.workspace.getSourceChanges?.(checkpoint) ?? EMPTY_SOURCE_CHANGES;
  }

  private emitProgress(event: AgentProgressEvent): void {
    void this.config.events?.emit({ type: "progress", event });
  }
}
