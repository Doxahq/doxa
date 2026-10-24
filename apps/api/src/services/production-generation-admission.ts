import {
  EDITOR_CONTENT_GENERATION_MESSAGE,
  UNCHANGED_GENERATION_MESSAGE,
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
import {
  resolveGenerationExecutionConfig,
} from "./generation-execution-config";
import {
  GitHubProductionGenerationSource,
} from "./production-generation-source";

export type { ProductionGenerationBaseline };

export interface ProductionGenerationTarget {
  revision: string;
  treeHash: string;
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
    };

export interface ProductionGenerationJobsStore {
  create(
    input: CreateProductionGenerationJobInput,
  ): Promise<ProductionGenerationJobAdmission>;
}

export interface ProductionGenerationAdmissionDependencies {
  source: ProductionGenerationSource;
  baselines: ProductionBaselinesStore;
  jobs: ProductionGenerationJobsStore;
  executionConfig: GenerationExecutionConfig;
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
      executionConfig:
        resolveGenerationExecutionConfig(env),
    });
  }

  async admit(input: {
    projectId: string;
    userId: string;
    force?: boolean;
    /** Use the hand-written pages as the start of a first generation. */
    seed?: boolean;
    trigger?: ProductionGenerationTrigger;
  }): Promise<ProductionGenerationAdmission> {
    const target =
      await this.dependencies.source.resolveTarget(
        input.projectId,
      );
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
      return {
        outcome: "confirmation_required",
        reason: "unchanged_source",
        message: UNCHANGED_GENERATION_MESSAGE,
      };
    }

    return this.dependencies.jobs.create({
      projectId: input.projectId,
      userId: input.userId,
      trigger: input.trigger ?? "manual",
      baselineRevision:
        baseline?.sourceRevision ?? target.revision,
      targetRevision: target.revision,
      sourceTreeHash: target.treeHash,
      baselineVersionId: baseline?.versionId ?? null,
      seedVersionId: input.seed ? handWrittenVersionId : null,
      ...this.dependencies.executionConfig,
    });
  }
}
