import type {
  CompleteJobOutputInput,
  CurrentChangeProposalState,
  GenerationExecutionContext,
  GenerationPageState,
  IncrementalGenerationPlan,
  SourceCheckoutSpec,
  StagedRuntimePage,
} from "@doxahq/contracts";
import { stagedRuntimePageSchema } from "@doxahq/contracts";
import { sourcePathForHref } from "@doxahq/docs-engine";

export function assembleCheckpointedPages(
  expectedPageIds: readonly string[],
  batches: readonly (readonly StagedRuntimePage[])[],
): StagedRuntimePage[] {
  const pagesById = new Map<string, StagedRuntimePage>();
  for (const batch of batches) {
    for (const page of batch) {
      if (pagesById.has(page.id)) {
        throw new Error(`Duplicate generated page checkpoint: ${page.id}`);
      }
      pagesById.set(page.id, page);
    }
  }

  const expected = new Set(expectedPageIds);
  for (const pageId of pagesById.keys()) {
    if (!expected.has(pageId)) throw new Error(`Unexpected generated page checkpoint: ${pageId}`);
  }
  const missing = expectedPageIds.filter((pageId) => !pagesById.has(pageId));
  if (missing.length > 0) {
    throw new Error(`Missing generated page checkpoint(s): ${missing.join(", ")}`);
  }
  return expectedPageIds.map((pageId) => requiredPage(pagesById, pageId));
}

export function assembleIncrementalPages(
  expectedPageIds: readonly string[],
  regeneratedBatches: readonly (readonly StagedRuntimePage[])[],
  reusedPages: readonly StagedRuntimePage[],
  plan: IncrementalGenerationPlan,
): StagedRuntimePage[] {
  assertExactPageIds(
    plan.regeneratePageIds,
    regeneratedBatches.flat().map((page) => page.id),
    "regenerated",
  );
  assertExactPageIds(
    plan.reusePageIds,
    reusedPages.map((page) => page.id),
    "reused",
  );
  assertExactPageIds(
    expectedPageIds,
    [...plan.regeneratePageIds, ...plan.reusePageIds],
    "planned",
  );
  return assembleCheckpointedPages(
    expectedPageIds,
    [...regeneratedBatches, reusedPages],
  );
}

/**
 * The page that a run reuses. The published baseline holds the page as it is
 * live, which can differ from what the generator wrote when a person rejected
 * a rewrite in a review; the live page wins. A page that the baseline does not
 * have comes from the artifact of the state, which must pass its hash check.
 */
export async function materializeReusablePage(input: {
  state: GenerationPageState;
  siteId: string;
  baselineArtifactPrefix: string;
  readArtifact(key: string): Promise<string | null>;
  hashContent(content: string): Promise<string>;
}): Promise<StagedRuntimePage> {
  const published = await input.readArtifact(
    `${input.baselineArtifactPrefix}/${sourcePathForHref(input.state.route)}`,
  );
  const content = published ?? (await readStateArtifact(input));
  return stagedRuntimePageSchema.parse({
    id: input.state.pageId,
    title: input.state.title,
    route: input.state.route,
    navigationPath: input.state.navigationPath,
    content,
    dependencies: input.state.dependencies,
    contentHash:
      published === null
        ? input.state.contentHash
        : await input.hashContent(published),
    pageInputHash: input.state.pageInputHash,
  });
}

async function readStateArtifact(input: {
  state: GenerationPageState;
  siteId: string;
  readArtifact(key: string): Promise<string | null>;
  hashContent(content: string): Promise<string>;
}): Promise<string> {
  if (!input.state.artifactKey.startsWith(`sites/${input.siteId}/versions/`)) {
    throw new Error(
      `Reusable page state is invalid: ${input.state.pageId}`,
    );
  }
  const content = await input.readArtifact(input.state.artifactKey);
  if (content === null) {
    throw new Error(
      `Reusable page artifact is missing: ${input.state.pageId}`,
    );
  }
  if (await input.hashContent(content) !== input.state.contentHash) {
    throw new Error(
      `Reusable page artifact failed integrity validation: ${input.state.pageId}`,
    );
  }
  return content;
}

export function isAcceptedPullRequestRevision(
  context: GenerationExecutionContext,
  current: CurrentChangeProposalState,
): boolean {
  const proposal = context.changeProposal;
  return Boolean(
    proposal &&
    context.job.targetRevision &&
    current.externalId === proposal.externalId &&
    current.number === proposal.number &&
    current.state === "open" &&
    !current.draft &&
    current.baseRef === proposal.baseRef &&
    current.baseRevision === proposal.baseRevision &&
    current.headRevision === context.job.targetRevision,
  );
}

export function resolvePreviewExecutionConfig(
  context: GenerationExecutionContext,
): ReturnType<typeof resolveGenerationExecutionConfig> {
  return resolveGenerationExecutionConfig(context);
}

export function resolveGenerationExecutionConfig(
  context: GenerationExecutionContext,
): {
  plannerModel: string;
  writerModel: string;
  generationProfile: "fast-mvp" | "full-prod";
  planningFingerprint: string;
  writingFingerprint: string;
  generatorFingerprint: string;
} {
  const {
    plannerModel,
    writerModel,
    generationProfile,
    planningFingerprint,
    writingFingerprint,
    generatorFingerprint,
  } = context.job;
  if (
    !plannerModel ||
    !writerModel ||
    !generationProfile ||
    !planningFingerprint ||
    !writingFingerprint ||
    !generatorFingerprint
  ) {
    throw new Error(
      "Generation execution configuration is incomplete.",
    );
  }
  return {
    plannerModel,
    writerModel,
    generationProfile,
    planningFingerprint,
    writingFingerprint,
    generatorFingerprint,
  };
}

export function modelForGenerationStage(
  config: ReturnType<typeof resolveGenerationExecutionConfig>,
  stage: "analysis" | "plan" | "structure" | "write",
): string {
  return stage === "write"
    ? config.writerModel
    : config.plannerModel;
}

/** A production run starts from a person, or from Doxabot after merges. */
export function isProductionTrigger(
  trigger: GenerationExecutionContext["job"]["trigger"],
): boolean {
  return trigger === "manual" || trigger === "merge";
}

export function isRevisionAwareProductionContext(
  context: GenerationExecutionContext | null,
): context is GenerationExecutionContext {
  return Boolean(
    context &&
    isProductionTrigger(context.job.trigger) &&
    context.job.publicationMode === "production" &&
    context.job.targetRevision &&
    context.job.plannerModel &&
    context.job.writerModel &&
    context.job.planningFingerprint &&
    context.job.writingFingerprint &&
    context.job.generationProfile &&
    context.job.generatorFingerprint,
  );
}

type ProductionCompletionState = Omit<
  Extract<
    CompleteJobOutputInput,
    { publicationMode: "publish" }
  >,
  | "publicationMode"
  | "baselineVersionId"
  | "generatorFingerprint"
>;

export function createProductionCompletionInput(
  context: GenerationExecutionContext,
  state: ProductionCompletionState,
): Extract<
  CompleteJobOutputInput,
  { publicationMode: "publish" }
> {
  if (!isRevisionAwareProductionContext(context)) {
    throw new Error(
      "Revision-aware production generation context is incomplete.",
    );
  }

  return {
    publicationMode: "publish",
    ...state,
    baselineVersionId: context.job.baselineVersionId,
    generatorFingerprint:
      resolveGenerationExecutionConfig(context)
        .generatorFingerprint,
  };
}

export function resolveGenerationCheckoutSpec(
  context: GenerationExecutionContext,
): SourceCheckoutSpec {
  const targetRevision = context.job.targetRevision;
  if (!targetRevision) {
    throw new Error("Generation target revision is missing.");
  }

  if (context.job.publicationMode === "production") {
    return {
      kind: "commit",
      baselineRevision:
        context.job.baselineRevision ?? targetRevision,
      targetRevision,
    };
  }

  const proposal = context.changeProposal;
  if (!proposal) {
    throw new Error("Preview change proposal context is missing.");
  }
  return {
    kind: "pull_request_merge",
    pullRequestNumber: proposal.number,
    baselineRevision:
      context.job.baselineRevision ?? proposal.baseRevision,
    baseRevision: proposal.baseRevision,
    headRevision: targetRevision,
  };
}

function assertExactPageIds(
  expectedPageIds: readonly string[],
  actualPageIds: readonly string[],
  label: string,
): void {
  const expected = new Set(expectedPageIds);
  const actual = new Set(actualPageIds);
  if (
    expected.size !== expectedPageIds.length ||
    actual.size !== actualPageIds.length ||
    expected.size !== actual.size ||
    [...expected].some((pageId) => !actual.has(pageId))
  ) {
    throw new Error(
      `Incremental ${label} page set does not match its generation plan.`,
    );
  }
}

function requiredPage(
  pagesById: ReadonlyMap<string, StagedRuntimePage>,
  pageId: string,
): StagedRuntimePage {
  const page = pagesById.get(pageId);
  if (!page) {
    throw new Error(`Missing generated page checkpoint: ${pageId}`);
  }
  return page;
}
