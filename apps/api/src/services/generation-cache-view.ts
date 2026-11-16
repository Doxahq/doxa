import type { ProjectGenerationCache } from "@doxahq/contracts";
import type { DbEnv } from "@doxahq/db";
import {
  DoxabotSettingsRepository,
  type PublishedPreviewBaselineReader,
} from "../repositories/doxabot-settings";
import type { GenerationCacheState } from "../repositories/generation-cache";
import {
  ProductionBaselinesRepository,
  type ProductionBaselinesStore,
} from "../repositories/production-baselines";

/** The two baseline rules that decide how warm the next runs of a project start. */
export interface NextRunBaselines {
  /** Pull request admission: any published version that Clear cache did not retire. */
  readonly published: PublishedPreviewBaselineReader;
  /** A generation that a person starts: a published version with its saved run state. */
  readonly compatible: Pick<ProductionBaselinesStore, "findCompatiblePublished">;
}

export function nextRunBaselinesFromEnv(env: DbEnv): NextRunBaselines {
  return {
    published: new DoxabotSettingsRepository(env),
    compatible: new ProductionBaselinesRepository(env),
  };
}

/**
 * The generation cache of a project with the temperature of its next runs
 * (billing decision D21).
 *
 * The next pull request run uses the rule of pull request admission
 * (`webhook-orchestrator.ts`, `context.publishedBaseline`): the published
 * version is its baseline unless Clear cache retired it, even when that
 * version has no saved run state. Without one the run is cold, a Full
 * generation (`generation.run`), else an Update run (`doxabot.run`). So the
 * Doxabot page and the bill always agree.
 *
 * The next generation that a person starts uses the stricter
 * `findCompatiblePublished`, as `production-generation-admission.ts` does: it
 * needs the saved run state too. Both lookups ignore versions from before
 * Clear cache.
 */
export async function withNextRunTemperature(
  cache: GenerationCacheState,
  projectId: string,
  baselines: NextRunBaselines,
): Promise<ProjectGenerationCache> {
  const [published, compatible] = await Promise.all([
    baselines.published.getPublishedPreviewBaseline(projectId),
    baselines.compatible.findCompatiblePublished({ projectId }),
  ]);
  const pullRequestCold = published === null;
  return {
    ...cache,
    nextPullRequestRunCold: pullRequestCold,
    nextPullRequestRunAction: pullRequestCold ? "generation.run" : "doxabot.run",
    nextGenerationRunCold: compatible === null,
  };
}
