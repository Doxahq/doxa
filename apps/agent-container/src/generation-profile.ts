import type { ContainerGenerateRequest } from "@doxahq/contracts";
import type {
  DocsQualityValidationConfig,
  DocumentationStructure,
  PageFailureAction,
  PageGenerationFailure,
  WriterExplorationMode,
  WriterValidationConfig,
} from "@doxahq/agent";
import {
  DEFAULT_WRITER_MAX_STEPS,
  DEFAULT_WRITER_WIDTH_POLICY,
  editorialPageCount,
  StructureInfeasibleConstraintsError,
} from "@doxahq/agent";

export const DEFAULT_FAST_MVP_EDITORIAL_PAGE_BUDGET = 24;
export const DEFAULT_FULL_PROD_EDITORIAL_PAGE_BUDGET = 36;
/**
 * The most page writers one job runs at once. The worker usually sends its
 * own ceiling; the adaptive limiter starts lower and grows toward it.
 */
export const DEFAULT_PAGE_CONCURRENCY = DEFAULT_WRITER_WIDTH_POLICY.max;
export const HOSTED_WRITER_EXPLORATION = resolvedWriterExploration();
/** Model turns of one agentic writer attempt, the forced final turn included. */
export const HOSTED_WRITER_MAX_STEPS = DEFAULT_WRITER_MAX_STEPS;
export const HOSTED_WRITER_VALIDATION: WriterValidationConfig = {
  maxAttempts: 3,
  mdxCompile: true,
  timeoutMs: 10_000,
  targetedRepairClasses: [
    "mdx",
    "frontmatter",
    "length",
  ],
};
export const HOSTED_DOCS_QUALITY: DocsQualityValidationConfig = {
  enabled: true,
  maxRepairAttempts: 3,
  maxRepairAttemptsPerPage: 2,
};

export function resolvedWriterExploration(
  env: Record<string, string | undefined> = process.env,
): WriterExplorationMode {
  return env.DOXA_WRITER_EXPLORATION === "agentic"
    ? "agentic"
    : "evidence_first";
}

/**
 * A failing page retries once with the writer model, then once with the
 * fallback model. After that it is skipped: the page is the unit of
 * failure, and the workflow decides whether the run still succeeds.
 */
export const HOSTED_PAGE_FAILURE_MAX_RETRIES = 2;

type FailureRetryState = Pick<PageGenerationFailure, "retryCount" | "retryBudgetExhausted">;

export function hostedPageFailureAction(failure: FailureRetryState): PageFailureAction {
  return !failure.retryBudgetExhausted &&
      failure.retryCount < HOSTED_PAGE_FAILURE_MAX_RETRIES
    ? "retry"
    : "skip";
}

/** Quality repairs have their own budgets; a page that exhausts them is skipped. */
export function hostedDocsQualityFailureAction(failure: FailureRetryState): PageFailureAction {
  return failure.retryBudgetExhausted ? "skip" : "retry";
}

/**
 * The model that extracts REST endpoints on the model route: the run's
 * extraction model, else its writer model, else the one model of a run
 * without a model config.
 */
export function resolvedRestExtractionModel(input: ContainerGenerateRequest): string | undefined {
  const models = input.modelConfig;
  return models?.restExtractionModel ?? models?.writerModel ?? input.model;
}

export function resolvedPageConcurrency(input: ContainerGenerateRequest): number {
  return input.pageConcurrency ?? DEFAULT_PAGE_CONCURRENCY;
}

/**
 * The most guide, concept and workflow pages a plan may have. Reference and
 * collection pages have no limit: every endpoint, module and collection item
 * gets its page. The deprecated `maxPages` request field has no effect.
 */
export function resolvedEditorialPageBudget(
  input: Pick<ContainerGenerateRequest, "generationProfile">,
): number {
  return input.generationProfile === "full-prod"
    ? DEFAULT_FULL_PROD_EDITORIAL_PAGE_BUDGET
    : DEFAULT_FAST_MVP_EDITORIAL_PAGE_BUDGET;
}

export interface StructureBudgetOptions {
  reviewDegraded?: boolean;
}

export async function applyGenerationProfileBudget(
  input: ContainerGenerateRequest,
  structure: DocumentationStructure,
  emitEvent: (type: string, message: string, data?: Record<string, unknown>) => Promise<void>,
  options: StructureBudgetOptions = {},
): Promise<DocumentationStructure> {
  const editorialBudget = resolvedEditorialPageBudget(input);
  const editorialCount = editorialPageCount(structure);

  await emitEvent("structure_budget_applied", "Documentation structure budget evaluated.", {
    generationProfile: input.generationProfile,
    originalPageCount: countStructurePages(structure),
    editorialBudget,
    editorialPageCount: editorialCount,
    reviewDegraded: options.reviewDegraded ?? false,
  });

  if (editorialCount <= editorialBudget) {
    return structure;
  }
  if (options.reviewDegraded) {
    return structure;
  }
  throw new StructureInfeasibleConstraintsError(
    `The documentation plan could not be reduced from ${editorialCount} editorial pages to the editorial limit of ${editorialBudget}. Generation stopped before writing incomplete documentation.`,
  );
}

export function countStructurePages(structure: DocumentationStructure): number {
  return structure.sections.reduce(
    (sectionTotal, section) => sectionTotal + section.pages.length,
    0,
  );
}
