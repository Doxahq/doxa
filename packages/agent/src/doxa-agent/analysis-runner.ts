import { join } from "path";
import { fileExists, readTextFile } from "../utils/runtime";
import { run, stream, explorationTools } from "../core";
import type {
  AgentOptions,
  AgentSpanCallback,
  AgentUsageCallback,
  Provider,
} from "../core";
import type {
  AgentConfig,
  AgentProgressCallback,
  ProjectAnalysis,
  ResolvedDocumentationGenerationBrief,
} from "../types";
import type { AnalysisCacheCheckResult } from "../cache";
import { normalizeProjectAnalysis } from "../utils/analysis-normalizer";
import { EXPLORATION_FINALIZATION_PROMPT, prompts } from "./prompts";
import type { PromptRegistry } from "./prompts";
import type { RestReferencePromptMode } from "./prompts/dynamic";
import { REPO_MAP_EXPLORATION_MAX_STEPS } from "./constants";
import { parseProjectAnalysis } from "./json-parsing";
import { resolveDocumentationBrief } from "./documentation-policy";
import {
  ProjectPathAccessError,
  resolveProjectPath,
} from "../core/tools/project-path";

/**
 * With a repo map the explorer gets a lower turn cap and a final tool-free
 * turn that writes the summary. Without one it explores as it always did.
 */
function explorationLoopOptions(
  repoMap: string | undefined,
): Pick<AgentOptions, "maxSteps" | "loopPolicy"> {
  return repoMap
    ? {
        maxSteps: REPO_MAP_EXPLORATION_MAX_STEPS,
        loopPolicy: { finalizationPrompt: EXPLORATION_FINALIZATION_PROMPT },
      }
    : {};
}

export async function exploreProject(
  provider: Provider,
  config: AgentConfig,
  onProgress?: AgentProgressCallback,
  promptRegistry: PromptRegistry = prompts,
  repoMap?: string,
  restReference?: RestReferencePromptMode,
): Promise<string> {
  const prompt = promptRegistry.buildExplorationPrompt({
    cwd: config.cwd,
    documentationBrief: resolveDocumentationBrief(config.documentationBrief),
    repoMap,
    restReference,
  });

  const MAX_EXPLORATION_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_EXPLORATION_ATTEMPTS; attempt++) {
    let lastProgress = 10;
    let finalText = "";
    let toolCallCount = 0;
    let lastError: Error | null = null;

    try {
      for await (const event of stream(
        {
          provider,
          systemPrompt: prompt.system,
          tools: explorationTools(config.cwd, config.toolPolicy),
          ...explorationLoopOptions(repoMap),
          abortController: config.abortController,
          modelCallTimeoutMs: config.modelCallTimeoutMs,
          modelCallMaxDurationMs: config.modelCallMaxDurationMs,
          usageContext: { operation: "analysis", attempt },
          onUsage: config.onModelUsage,
          onSpan: config.onSpan,
        },
        prompt.user
      )) {
        if (event.type === "tool_call_start") {
          toolCallCount++;
          lastProgress = Math.min(lastProgress + 8, 60);
          onProgress?.({
            stage: "analyzing",
            message: `Exploring codebase (${event.name})...`,
            progress: lastProgress,
          });
        }
        if (event.type === "done") {
          finalText = event.text;
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    // Success — got meaningful output
    if (finalText && finalText.trim().length > 0) {
      return finalText;
    }

    // Failure — decide whether to retry
    if (attempt < MAX_EXPLORATION_ATTEMPTS) {
      const reason = lastError
        ? `API error: ${lastError.message}`
        : toolCallCount > 0
          ? `Model explored ${toolCallCount} file(s) but returned empty output`
          : "Model returned no output and made no tool calls";

      onProgress?.({
        stage: "analyzing",
        message: `Exploration failed (${reason}), retrying (${attempt + 1}/${MAX_EXPLORATION_ATTEMPTS})...`,
        progress: 10,
      });

      // Brief pause before retry
      config.abortController?.signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      config.abortController?.signal.throwIfAborted();
      continue;
    }

    // All attempts exhausted
    if (lastError) {
      throw new Error(`Exploration failed after ${MAX_EXPLORATION_ATTEMPTS} attempts: ${lastError.message}`);
    }
    throw new Error(
      `Exploration produced no output after ${MAX_EXPLORATION_ATTEMPTS} attempts. ` +
      `The model made ${toolCallCount} tool call(s) but did not generate a summary. ` +
      `This is usually a transient API issue — try running the command again.`
    );
  }

  // TypeScript: unreachable, but satisfies return type
  throw new Error("Exploration failed unexpectedly");
}

export async function generateAnalysisWithRetry(
  provider: Provider,
  explorationContext: string,
  onProgress?: AgentProgressCallback,
  attempt: number = 1,
  promptRegistry: PromptRegistry = prompts,
  abortController?: AbortController,
  documentationBrief?: ResolvedDocumentationGenerationBrief,
  onUsage?: AgentUsageCallback,
  onSpan?: AgentSpanCallback,
  modelCallTimeoutMs?: number,
  modelCallMaxDurationMs?: number,
  repoMap?: string,
  restReference?: RestReferencePromptMode,
): Promise<ProjectAnalysis> {
  const maxAttempts = 3;

  const prompt = promptRegistry.buildAnalysisPrompt({
    explorationContext,
    attempt,
    documentationBrief,
    repoMap,
    restReference,
  });

  const result = await run(
    {
      provider,
      systemPrompt: prompt.system,
      responseFormat: "json",
      abortController,
      modelCallTimeoutMs,
      modelCallMaxDurationMs,
      usageContext: { operation: "analysis", attempt },
      onUsage,
      onSpan,
    },
    prompt.user
  );

  onProgress?.({ stage: "analyzing", message: "Parsing analysis results...", progress: 85 });

  try {
    return parseProjectAnalysis(result.text);
  } catch (error) {
    if (attempt < maxAttempts) {
      onProgress?.({
        stage: "analyzing",
        message: `Retrying JSON generation (attempt ${attempt + 1}/${maxAttempts})...`,
        progress: 75,
      });
      return generateAnalysisWithRetry(
        provider,
        explorationContext,
        onProgress,
        attempt + 1,
        promptRegistry,
        abortController,
        documentationBrief,
        onUsage,
        onSpan,
        modelCallTimeoutMs,
        modelCallMaxDurationMs,
        repoMap,
        restReference,
      );
    }
    throw error;
  }
}

export async function runIncrementalAnalysis(
  provider: Provider,
  config: AgentConfig,
  cacheCheck: AnalysisCacheCheckResult,
  onProgress?: AgentProgressCallback,
  promptRegistry: PromptRegistry = prompts,
): Promise<ProjectAnalysis> {
  const allChanges = [...cacheCheck.changedFiles, ...cacheCheck.addedFiles];
  const deletions = cacheCheck.deletedFiles;

  // Read the content of changed/added files
  const fileContents: string[] = [];
  for (const filePath of allChanges.slice(0, 50)) {
    // Limit to 50 files for token efficiency
    try {
      const fullPath = await resolveProjectPath(config.cwd, filePath);
      if (await fileExists(fullPath)) {
        const content = await readTextFile(fullPath);
        // Limit per-file content to avoid token overflow
        const truncated = content.length > 5000
          ? content.slice(0, 5000) + "\n... (truncated)"
          : content;
        fileContents.push(`=== ${filePath} ===\n${truncated}`);
      }
    } catch (error) {
      if (error instanceof ProjectPathAccessError) throw error;
      // Skip unreadable files
    }
  }

  onProgress?.({
    stage: "analyzing",
    message: `Updating analysis with ${allChanges.length} changed file(s)...`,
    progress: 40,
  });

  const prompt = promptRegistry.buildIncrementalAnalysisPrompt({
    previousAnalysis: normalizeProjectAnalysis(cacheCheck.cachedAnalysis),
    changedFiles: cacheCheck.changedFiles,
    addedFiles: cacheCheck.addedFiles,
    deletedFiles: deletions,
    fileContents,
    documentationBrief: resolveDocumentationBrief(config.documentationBrief),
  });

  const result = await run(
    {
      provider,
      systemPrompt: prompt.system,
      responseFormat: "json",
      abortController: config.abortController,
      modelCallTimeoutMs: config.modelCallTimeoutMs,
      modelCallMaxDurationMs: config.modelCallMaxDurationMs,
      usageContext: { operation: "analysis", attempt: 1 },
      onUsage: config.onModelUsage,
      onSpan: config.onSpan,
    },
    prompt.user
  );

  onProgress?.({ stage: "analyzing", message: "Parsing incremental analysis...", progress: 85 });

  return parseProjectAnalysis(result.text);
}
