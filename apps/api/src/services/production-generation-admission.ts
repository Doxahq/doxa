import {
  EDITOR_CONTENT_GENERATION_MESSAGE,
  UNCHANGED_GENERATION_MESSAGE,
  UNCHANGED_SOURCE_INSTRUCTIONS_UNKNOWN_MESSAGE,
  type GenerationConfirmationReason,
  type GenerationExecutionConfig,
} from "@doxahq/contracts";
import type {
  CreateProductionGenerationJobInput,
  ProductionGenerationJobAdmission,
  ProductionGenerationTrigger,
} from "../repositories/jobs";
import type {
  ProductionBaselinesStore,
  ProductionGenerationBaseline,
} from "../repositories/production-baselines";
import {
  ProductionBaselinesRepository,
} from "../repositories/production-baselines";
import {
  JobsRepository,
} from "../repositories/jobs";
import type { Env } from "../env";
import type { ProductAnalytics } from "@doxahq/analytics";
import { productAnalyticsOf } from "./analytics/product-analytics";
import { captureGenerationStarted, type GenerationStartedBy } from "./generation-analytics";
import {
  instructionsChangeCheckFromEnv,
  type InstructionsChangeCheck,
} from "./doxabot/instructions-change";
import {
  resolveGenerationExecutionConfig,
} from "./generation-execution-config";
import {
  GitHubProductionGenerationSource,
} from "./production-generation-source";
import type { BillingRefusal, GenerationMetering } from "./billing/generation-metering";
import { meteredActionOf, requiredFeaturesOf, runModels } from "./billing/generation-metering";
import { generationMeteringFromEnv } from "./billing/generation-metering-env";
import {
  checkRepositorySize,
  maxRepositorySizeKbFromEnv,
  type RepositoryTooLarge,
} from "./repository-size";

export type { ProductionGenerationBaseline };

export interface ProductionGenerationTarget {
  revision: string;
  treeHash: string;
  /** GitHub's repository size in KB. Absent: the source does not know it, so no size check. */
  sizeKb?: number;
}

export interface ProductionGenerationSource {
  resolveTarget(projectId: string): Promise<ProductionGenerationTarget>;
}

export type ProductionGenerationAdmission =
  | ProductionGenerationJobAdmission
  | {
      outcome: "confirmation_required";
      reason: GenerationConfirmationReason;
      message: string;
    }
  /** Billing refused the run: 402 `credits_exhausted`, 403 `plan_limit` or another refusal (spec 10.6). */
  | { outcome: "billing_refused"; error: BillingRefusal }
  /** The repository is above `MAX_REPOSITORY_SIZE_KB`: no job, no clone, no model call. */
  | RepositoryTooLarge;

export interface ProductionGenerationJobsStore {
  create(
    input: CreateProductionGenerationJobInput,
  ): Promise<ProductionGenerationJobAdmission>;
}

export interface ProductionGenerationAdmissionDependencies {
  source: ProductionGenerationSource;
  baselines: ProductionBaselinesStore;
  jobs: ProductionGenerationJobsStore;
  instructions: InstructionsChangeCheck;
  executionConfig: GenerationExecutionConfig;
  /** The credit meter (billing spec 10.5). Absent: no metering, as with `BILLING_ENFORCEMENT=off`. */
  metering?: Pick<GenerationMetering, "mode" | "admit" | "abandon">;
  /** The planner, writer and fallback models of a run. Default: planner and writer. */
  runModels?: (config: GenerationExecutionConfig) => string[];
  /** The largest repository a run accepts, in KB. Absent: no size limit. */
  maxRepositorySizeKb?: number;
  /** Product analytics. Absent: nothing is reported. */
  analytics?: ProductAnalytics;
}

export class ProductionGenerationAdmissionService {
  constructor(
    private readonly dependencies:
      ProductionGenerationAdmissionDependencies,
  ) {}

  static fromEnv(
    env: Env,
    jobs: ProductionGenerationJobsStore =
      new JobsRepository(env),
  ): ProductionGenerationAdmissionService {
    return new ProductionGenerationAdmissionService({
      source: GitHubProductionGenerationSource.fromEnv(env),
      baselines: new ProductionBaselinesRepository(env),
      jobs,
      instructions: instructionsChangeCheckFromEnv(env),
      executionConfig:
        resolveGenerationExecutionConfig(env),
      metering: generationMeteringFromEnv(env),
      runModels: (config) => runModels(env, config),
      maxRepositorySizeKb: maxRepositorySizeKbFromEnv(env),
      analytics: productAnalyticsOf(env),
    });
  }

  async admit(input: {
    projectId: string;
    userId: string;
    force?: boolean;
    /** Use the hand-written pages as the start of a first generation. */
    seed?: boolean;
    trigger?: ProductionGenerationTrigger;
    startedBy?: GenerationStartedBy;
  }): Promise<ProductionGenerationAdmission> {
    const target =
      await this.dependencies.source.resolveTarget(
        input.projectId,
      );
    // Before any other check: a forced run of a too large repository is refused too.
    const { maxRepositorySizeKb } = this.dependencies;
    if (maxRepositorySizeKb !== undefined) {
      const tooLarge = checkRepositorySize(target.sizeKb, maxRepositorySizeKb);
      if (tooLarge) return tooLarge;
    }
    const baseline =
      await this.dependencies.baselines.findCompatiblePublished({
        projectId: input.projectId,
      });

    // Without a baseline the run cannot build on hand-written pages, so the
    // person confirms that the generation may replace them in a review, and
    // chooses whether the run starts from those pages.
    const handWrittenVersionId =
      baseline === null
        ? await this.dependencies.baselines.handWrittenVersion({
            projectId: input.projectId,
          })
        : null;
    if (!input.force && handWrittenVersionId !== null) {
      return {
        outcome: "confirmation_required",
        reason: "editor_content",
        message: EDITOR_CONTENT_GENERATION_MESSAGE,
      };
    }

    if (
      !input.force &&
      baseline?.sourceTreeHash === target.treeHash &&
      baseline.generatorFingerprint ===
        this.dependencies.executionConfig.generatorFingerprint
    ) {
      // New instructions change the docs with no change in the source.
      const instructions = await this.dependencies.instructions.changedSincePublished({
        projectId: input.projectId,
        baseline,
      });
      if (instructions !== "changed") {
        return {
          outcome: "confirmation_required",
          reason: "unchanged_source",
          message: instructions === "unchanged"
            ? UNCHANGED_GENERATION_MESSAGE
            : UNCHANGED_SOURCE_INSTRUCTIONS_UNKNOWN_MESSAGE,
        };
      }
    }

    const trigger = input.trigger ?? "manual";
    const jobInput: CreateProductionGenerationJobInput = {
      projectId: input.projectId,
      userId: input.userId,
      trigger,
      baselineRevision:
        baseline?.sourceRevision ?? target.revision,
      targetRevision: target.revision,
      sourceTreeHash: target.treeHash,
      baselineVersionId: baseline?.versionId ?? null,
      seedVersionId: input.seed ? handWrittenVersionId : null,
      ...this.dependencies.executionConfig,
    };
    const { metering } = this.dependencies;
    if (!metering || metering.mode === "off") {
      return this.reportStarted(await this.dependencies.jobs.create(jobInput), jobInput, input.startedBy);
    }

    // Billing spec 10.5 step 1: hold the first credits before the job exists,
    // so a refused run leaves no job behind. The job takes the held ID.
    const jobId = crypto.randomUUID();
    const config = this.dependencies.executionConfig;
    const meteredJob = { publicationMode: "production", trigger, baselineVersionId: jobInput.baselineVersionId } as const;
    const admission = await metering.admit({
      jobId,
      projectId: input.projectId,
      // A merge run without a compatible published baseline is cold: a full generation.
      action: meteredActionOf(meteredJob),
      features: requiredFeaturesOf(meteredJob),
      models: this.dependencies.runModels?.(config) ?? [config.plannerModel, config.writerModel],
    });
    if (admission.kind === "refused") {
      return { outcome: "billing_refused", error: admission.error };
    }
    // A new job ID has no hold yet, so this cannot happen; never run without one.
    if (admission.kind === "busy") throw new Error(`Job ${jobId} already holds credits.`);
    let created: ProductionGenerationJobAdmission;
    try {
      created = await this.dependencies.jobs.create({ ...jobInput, id: jobId });
    } catch (error) {
      await metering.abandon(jobId, admission);
      throw error;
    }
    if (created.outcome !== "created") await metering.abandon(jobId, admission);
    return this.reportStarted(created, jobInput, input.startedBy);
  }

  /** `generation_started` for a new job; another outcome passes through unreported. */
  private reportStarted(
    created: ProductionGenerationJobAdmission,
    job: CreateProductionGenerationJobInput,
    startedBy: GenerationStartedBy | undefined,
  ): ProductionGenerationJobAdmission {
    if (created.outcome === "created" && this.dependencies.analytics) {
      captureGenerationStarted(this.dependencies.analytics, {
        ownerUserId: job.userId,
        projectId: job.projectId,
        trigger: job.trigger,
        baselineVersionId: job.baselineVersionId,
        startedBy,
      });
    }
    return created;
  }
}
