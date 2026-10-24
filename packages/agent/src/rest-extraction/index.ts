import type {
  AgentConfig,
  AgentProgressCallback,
  ProjectAnalysis,
  RestApiReferenceExtraction,
} from "../types";
import { createProviderFromConfig } from "../doxa-agent/provider-factory";
import { SecretRedactor } from "../reference-specs/secrets";
import { mapWithConcurrency } from "../utils/concurrency";
import { extractUnit, REST_EXTRACTION_PROMPT_VERSION, type UnitExtractionOptions } from "./extract-unit";
import {
  endpointFromAnswer,
  endpointsOfFiles,
  mergeExtractedEndpoints,
  type ExtractedEndpoint,
} from "./merge";
import { readRouteFile, scanRouteFiles, type RouteFile } from "./route-scan";
import { buildExtractionUnits, splitUnit, unitPaths, type ExtractionUnit } from "./units";

export { REST_EXTRACTION_PROMPT_VERSION } from "./extract-unit";
export { scanRouteFiles, routeFileOf, type RouteFile } from "./route-scan";
export { buildExtractionUnits, splitUnit, MAX_UNIT_CHARS, type ExtractionUnit } from "./units";

/** Extraction calls of one run; a larger API keeps the model endpoints for the other files. */
const MAX_UNITS = 400;
/** Halvings of a unit whose answer does not fit the output limit. */
const MAX_SPLIT_DEPTH = 4;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
/**
 * No extraction call starts after this time, so the analysis and the
 * structure keep their share of the plan step. The files left keep the
 * endpoints of the analysis answer.
 */
const DEFAULT_TIME_BUDGET_MS = 20 * 60_000;

export interface RestExtractionOptions {
  /** The analysis of the published version. Its endpoints of unchanged files are reused. */
  previous?: ProjectAnalysis;
  /** Files changed since the published version. Without it, nothing is reused. */
  changedPaths?: ReadonlySet<string>;
  onProgress?: AgentProgressCallback;
  /** 20 minutes by default. */
  timeBudgetMs?: number;
}

/**
 * The model route without a size limit. The endpoints come from one model
 * call for each unit of route files, not from the one analysis answer, so a
 * large API cannot overflow that answer. Unchanged files reuse their earlier
 * endpoints with no model call. A file whose extraction fails keeps the
 * endpoints of the analysis answer. The route is best effort: the scan finds
 * more route files, but it cannot prove that it found every route.
 */
export async function extractRestReference(
  config: AgentConfig,
  analysis: ProjectAnalysis,
  options: RestExtractionOptions = {},
): Promise<ProjectAnalysis> {
  const model = config.restExtractionModel;
  if (!model) return analysis;
  const files = await collectRouteFiles(config.cwd, analysis);
  if (files.length === 0) return analysis;

  const reusableFiles = reusableFileSet(options, model, files);
  const units = buildExtractionUnits(files.filter((file) => !reusableFiles.has(file.path))).slice(0, MAX_UNITS);
  options.onProgress?.({
    stage: "analyzing",
    message: `Extracting REST endpoints from ${files.length} route files...`,
    progress: 80,
  });

  const context: SplitContext = {
    options: unitOptions(config, model),
    redactor: new SecretRedactor(),
    deadline: Date.now() + (options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS),
  };
  const results = await mapWithConcurrency(
    units,
    (unit) => extractWithSplits(unit, context, 0),
    {
      concurrency: Math.min(config.concurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY),
      abortController: config.abortController,
    },
  );
  config.abortController?.signal.throwIfAborted();

  const extractedFiles = new Set(reusableFiles);
  const extracted: ExtractedEndpoint[] = endpointsOfFiles(options.previous, reusableFiles);
  results.forEach((result, index) => {
    if (result.status !== "fulfilled" || !result.value) return;
    for (const path of unitPaths(units[index]!)) extractedFiles.add(path);
    extracted.push(...result.value);
  });
  if (extractedFiles.size === 0) return analysis;

  // The analysis answer still covers the files that no extraction covered.
  const fromAnalysis = endpointsOfFiles(analysis, new Set(
    files.map((file) => file.path).filter((path) => !extractedFiles.has(path)),
  ));
  const extraction: RestApiReferenceExtraction = {
    promptVersion: REST_EXTRACTION_PROMPT_VERSION,
    model,
    files: [...extractedFiles].sort(),
  };
  return mergeExtractedEndpoints(analysis, [...extracted, ...fromAnalysis], extraction);
}

/** The route files of the analysis groups and of the scan, in path order. */
async function collectRouteFiles(checkoutRoot: string, analysis: ProjectAnalysis): Promise<RouteFile[]> {
  const scanned = await scanRouteFiles(checkoutRoot);
  const scannedPaths = new Set(scanned.map((file) => file.path));
  const named = new Set((analysis.referenceSurfaces?.rest?.groups ?? []).flatMap((group) => [
    ...group.sourceEvidence.map((evidence) => evidence.path),
    ...group.endpoints.flatMap((endpoint) => endpoint.sourceEvidence.map((evidence) => evidence.path)),
  ]));
  const extra: RouteFile[] = [];
  for (const path of named) {
    if (scannedPaths.has(path)) continue;
    const file = await readRouteFile(checkoutRoot, path);
    if (file) extra.push(file);
  }
  return [...scanned, ...extra].sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Files whose earlier endpoints stay valid: the earlier extraction used the
 * same prompt version and model, read the file, and the file did not change.
 */
function reusableFileSet(
  options: RestExtractionOptions,
  model: string,
  files: readonly RouteFile[],
): ReadonlySet<string> {
  const earlier = options.previous?.referenceSurfaces?.rest?.extraction;
  if (!earlier || !options.changedPaths) return new Set();
  if (earlier.promptVersion !== REST_EXTRACTION_PROMPT_VERSION || earlier.model !== model) return new Set();
  const earlierFiles = new Set(earlier.files);
  return new Set(files
    .map((file) => file.path)
    .filter((path) => earlierFiles.has(path) && !options.changedPaths!.has(path)));
}

interface SplitContext {
  options: UnitExtractionOptions;
  redactor: SecretRedactor;
  /** Epoch milliseconds after which no call starts. */
  deadline: number;
}

/**
 * The endpoints of a unit, splitting it in half while its answer does not
 * fit. Undefined when it fails or the time budget is spent.
 */
async function extractWithSplits(
  unit: ExtractionUnit,
  context: SplitContext,
  depth: number,
): Promise<ExtractedEndpoint[] | undefined> {
  if (Date.now() >= context.deadline) return undefined;
  const result = await extractUnit(unit, context.options);
  if (result.status === "done") {
    return result.endpoints.flatMap((answer) => endpointFromAnswer(answer, context.redactor) ?? []);
  }
  if (result.status === "failed" || depth >= MAX_SPLIT_DEPTH) return undefined;
  const halves = splitUnit(unit);
  if (!halves) return undefined;
  const [first, second] = await Promise.all(
    halves.map((half) => extractWithSplits(half, context, depth + 1)),
  );
  return first && second ? [...first, ...second] : undefined;
}

/** Every model of a run uses one provider and key; an injected provider has no model to swap. */
function unitOptions(config: AgentConfig, model: string): UnitExtractionOptions {
  return {
    provider: config.provider ?? createProviderFromConfig({ ...config, model }),
    abortController: config.abortController,
    modelCallTimeoutMs: config.modelCallTimeoutMs,
    modelCallMaxDurationMs: config.modelCallMaxDurationMs,
    onUsage: config.onModelUsage,
    onSpan: config.onSpan,
  };
}
