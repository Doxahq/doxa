import { z } from "zod";
import { referenceSourceReportSchema } from "./reference-source";
import {
  flaggedPageSchema,
  ownedPageFlagSchema,
  pageSourcesSchema,
} from "./generation-reviews";
import { siteConfigSchema } from "@doxahq/site-config";
import { projectEntitlementsSchema } from "./entitlements";
import {
  pageDependencyStateSchema,
  generationAnalysisStateSchema,
  generationSourceStateSchema,
  generationStructureStateSchema,
  incrementalGenerationPlanSchema,
  reusableGenerationStateSchema,
  sha256Schema,
} from "./generation-state";
import {
  generationModelConfigSchema,
  generationRepairDiagnosticSchema,
  generationUsageRecordSchema,
} from "./generation-observability";
import type {
  GenerationDatabaseCompatibility,
  GenerationRepairDiagnostic,
  GenerationUsageRecord,
  GenerationUsageSummary,
} from "./generation-observability";
import { DEFAULT_MODEL_PROVIDER, modelProviderSchema } from "./model-providers";
import type { WorkflowRestartPoint } from "./generation-resume";
import { writerHandoffManifestSchema } from "./writer-handoff";
import { projectTeamSchema } from "./teams";
import {
  repositorySnapshotSchema,
  sourceCheckoutSpecSchema,
} from "./source-checkout";
import { gitObjectIdSchema, sourceProviderSchema } from "./source-control";
import type {
  CreateReviewRunInput,
  ReviewRunResult,
  UpdateReviewRunInput,
} from "./review-runs";

export * from "./docs-content";
export * from "./doxabot";
export * from "./generation-observability";
export * from "./generation-resume";
export * from "./model-providers";
export * from "./reference-source";

export const WRITING_FINGERPRINT_VERSION = "doxabot-writing-v1";
/**
 * The version of the planning contract. A run whose baseline has another
 * version plans every page again. Bump it whenever the planner's output
 * format changes, and update PLANNER_OUTPUT_SCHEMA_HASH with it.
 */
export const PLANNING_FINGERPRINT_VERSION = "doxabot-planning-v6";
/**
 * The hash of the structure and structure review response schemas that
 * PLANNING_FINGERPRINT_VERSION was set for. A test in @doxahq/agent fails
 * when the schemas change, so the planning version cannot stay the same.
 */
export const PLANNER_OUTPUT_SCHEMA_HASH =
  "6d6ce0464bda23d6f05f906a43b37822676ba97f523bbc3e3ceb0558c132e73b";
export const WRITER_HANDOFF_CONTRACT_VERSION = "writer-handoff-v1";
/** The default models call the Anthropic API (DEFAULT_MODEL_PROVIDER). */
export const DEFAULT_DOXA_PLANNER_MODEL = "claude-sonnet-5-5";
export const DEFAULT_DOXA_WRITER_MODEL = "claude-haiku-5-5";
export const PUBLIC_DOCUMENTATION_POLICY_VERSION = "public-v1" as const;
/** The model-independent part of the hosted writer contract. */
export const WRITING_CONTRACT_VERSION = `${WRITING_FINGERPRINT_VERSION}:${WRITER_HANDOFF_CONTRACT_VERSION}`;
export * from "./generation-state";
export * from "./review-runs";
export * from "./source-checkout";
export * from "./source-control";
export * from "./writer-handoff";

export const githubRepositorySchema = z.object({
  id: z.string(),
  githubRepoId: z.string(),
  fullName: z.string(),
  owner: z.string(),
  name: z.string(),
  defaultBranch: z.string(),
  isPrivate: z.boolean(),
});

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  githubRepositoryId: z.string().nullable(),
  /** `owner/name` of the connected repository; null when none is connected. */
  repositoryFullName: z.string().nullable(),
  publishedVersionId: z.string().nullable(),
  docsUrl: z.string().nullable(),
  /** The team that shares the project; null for a personal project. */
  team: projectTeamSchema.nullable(),
});

const projectSlugInputSchema = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const createProjectInputSchema = z.object({
  githubRepositoryId: z.string().uuid(),
  name: z.string().trim().min(1).max(120).optional(),
  slug: projectSlugInputSchema.optional(),
});

/** A project with no repository that starts with the example docs site. */
/** How a project without a repository starts: the starter docs or an empty site. */
export const exampleDocsTemplateSchema = z.enum(["starter", "empty"]);

export const createExampleProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: projectSlugInputSchema.optional(),
  /** The starter docs when left out. */
  template: exampleDocsTemplateSchema.optional(),
});

export const connectProjectRepositoryInputSchema = z.object({
  githubRepositoryId: z.string().uuid(),
});

export const REPOSITORY_REQUIRED_MESSAGE =
  "Connect a GitHub repository to generate docs from your source code.";

export const generationJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export const generationJobTriggerSchema = z.enum(["manual", "doxabot", "merge"]);
export const generationPublicationModeSchema = z.enum([
  "production",
  "preview",
]);
export const sourceControlProviderSchema = sourceProviderSchema;
export const changeProposalStateSchema = z.enum(["open", "closed", "merged"]);
export const generationProfileSchema = z.enum(["fast-mvp", "full-prod"]);
export const generationExecutionConfigSchema = z
  .object({
    plannerModel: z.string().trim().min(1),
    writerModel: z.string().trim().min(1),
    generationProfile: generationProfileSchema,
    planningFingerprint: z.string().trim().min(1),
    writingFingerprint: z.string().trim().min(1),
    generatorFingerprint: z.string().trim().min(1),
  })
  .strict();
export const jobEventSourceSchema = z.enum([
  "api",
  "worker",
  "container",
  "agent",
  "system",
]);

/** The part of a run that a generation log line belongs to. */
export const generationLogPhaseSchema = z.enum([
  "run",
  "setup",
  "analyze",
  "plan",
  "write",
  "publish",
  "review",
]);
export const generationLogLevelSchema = z.enum(["info", "warning", "error"]);

export const generationJobSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  status: generationJobStatusSchema,
  docsVersionId: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ACTIVE_GENERATION_MESSAGE =
  "A generation is already in progress for this project. No new generation was started.";
export const UNCHANGED_GENERATION_MESSAGE =
  "The repository content and generation configuration have not changed since the current production deployment. A new generation will likely produce the same documentation.";

export const EDITOR_CONTENT_GENERATION_MESSAGE =
  "This site has pages that were written in the editor. A generation reads your repository and writes docs for it, so it can rename, merge, or remove those pages. The result goes to a review, and your live site does not change until you publish it.";

/**
 * Why a start needs a second click. A site with editor content has no
 * generation baseline, so the two reasons never apply to the same start.
 */
export const generationConfirmationReasonSchema = z.enum([
  "unchanged_source",
  "editor_content",
  /** A re-run of a generation that succeeded. */
  "rerun_succeeded",
]);

export const generationStartResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    job: generationJobSchema,
    outcome: z.literal("started"),
    message: z.null(),
  }),
  z.object({
    job: generationJobSchema,
    outcome: z.literal("already_active"),
    message: z.string().min(1),
  }),
  z.object({
    job: z.null(),
    outcome: z.literal("confirmation_required"),
    reason: generationConfirmationReasonSchema,
    message: z.string().min(1),
  }),
]);

export const generationAuthorKindSchema = z.enum(["user", "automation"]);

export const generationAuthorSchema = z.object({
  kind: generationAuthorKindSchema,
  displayName: z.string().min(1),
  githubLogin: z.string().min(1).nullable(),
  avatarUrl: z.string().url().nullable(),
});

export const generationCommitSchema = z.object({
  revision: z.string().min(1),
  shortRevision: z.string().min(1),
  url: z.string().url().nullable(),
  message: z.string().min(1).nullable(),
});

export const generationChangeProposalSchema = z.object({
  number: z.number().int().positive(),
  state: changeProposalStateSchema,
  url: z.string().url().nullable(),
});

export const generationSourceSchema = z.object({
  provider: sourceControlProviderSchema.nullable(),
  repositoryFullName: z.string().min(1).nullable(),
  repositoryUrl: z.string().url().nullable(),
  branch: z.string().min(1).nullable(),
  branchUrl: z.string().url().nullable(),
  commit: generationCommitSchema.nullable(),
  changeProposal: generationChangeProposalSchema.nullable(),
});

export const generationDomainRoleSchema = z.enum([
  "production",
  "generated",
  "preview",
  "permanent",
]);

export const generationDomainSchema = z.object({
  hostname: z.string().min(1),
  url: z.string().url(),
  role: generationDomainRoleSchema,
});

/**
 * What happened to the version of a run:
 * - `live`: it is the live version of its environment.
 * - `in_review`: it waits in a generation review, which publishes it.
 * - `replaced`: it went live once, and a newer version replaced it.
 * - `not_published`: it never went live. The run failed, was cancelled, is
 *   still running, wrote no version, or its review was discarded.
 */
export const generationDeploymentStateSchema = z.enum([
  "live",
  "in_review",
  "replaced",
  "not_published",
]);

export const generationDeploymentSchema = z.object({
  environment: generationPublicationModeSchema,
  isCurrent: z.boolean(),
  state: generationDeploymentStateSchema,
  docsVersionId: z.string().nullable(),
  versionNumber: z.number().int().positive().nullable(),
  visitUrl: z.string().url().nullable(),
  domains: z.array(generationDomainSchema),
});

export const generationActionBlockedReasonSchema = z.enum([
  "not_succeeded",
  "no_docs_version",
  "already_production",
  "in_progress",
  "serving_production",
  "serving_preview",
  "review_required",
  /** A generation runs again only after it ends. */
  "not_finished",
  /** A newer run for the same pull request replaced this one. */
  "superseded",
  /** The pull request of a preview run is closed, merged, or a draft. */
  "change_not_open",
  /** Pull request previews are not available for the project. */
  "previews_unavailable",
  /**
   * A newer push replaced this pull request preview longer ago than the
   * retention policy keeps it promotable.
   */
  "promote_expired",
  /** The retention policy deleted the files of the version. */
  "version_collected",
  /** The run cannot continue from its failed step; a new run can start instead. */
  "not_resumable",
]);

export const generationActionsSchema = z.object({
  canPromote: z.boolean(),
  canDelete: z.boolean(),
  canRerun: z.boolean(),
  /** Continue a failed run from the step that failed, on the same commit and settings. */
  canResume: z.boolean(),
  promoteBlockedReason: generationActionBlockedReasonSchema.nullable(),
  deleteBlockedReason: generationActionBlockedReasonSchema.nullable(),
  rerunBlockedReason: generationActionBlockedReasonSchema.nullable(),
  resumeBlockedReason: generationActionBlockedReasonSchema.nullable(),
});

/** The runs that a re-run connects. A deleted run is not linked. */
export const generationRerunLinksSchema = z.object({
  /** The failed run that this run started again. */
  rerunOfId: z.string().nullable(),
  /** The newest run that started this failed run again. */
  rerunId: z.string().nullable(),
});

export const generationDetailSchema = generationJobSchema.extend({
  trigger: generationJobTriggerSchema,
  author: generationAuthorSchema,
  source: generationSourceSchema,
  deployment: generationDeploymentSchema,
  actions: generationActionsSchema,
  rerunLinks: generationRerunLinksSchema,
  /** Pages the run could not write. The run still ended with the others. */
  flaggedPages: z.array(flaggedPageSchema).default([]),
  /**
   * Where the REST reference of the run came from, with every spec problem
   * that the user can fix. Null when the run has not finished its analysis.
   */
  referenceSource: referenceSourceReportSchema.nullable().default(null),
});

export const promoteGenerationResultSchema = z.object({
  generation: generationDetailSchema,
  publishedVersionId: z.string(),
});

export const generationsPageSchema = z.object({
  generations: z.array(generationJobSchema),
  nextCursor: z.string().nullable(),
});

export const jobEventSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  sequence: z.number().int().positive(),
  source: jobEventSourceSchema,
  type: z.string(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  /** Set on generation log lines: events that the API rewrote for people. */
  phase: generationLogPhaseSchema.optional(),
  level: generationLogLevelSchema.optional(),
});

const generationStreamSequenceSchema = z.number().int().nonnegative();

export const generationStreamMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    generation: generationJobSchema,
    latestSequence: generationStreamSequenceSchema,
  }),
  z.object({
    type: z.literal("event"),
    event: jobEventSchema,
  }),
  z.object({
    type: z.literal("generation"),
    generation: generationJobSchema,
    latestSequence: generationStreamSequenceSchema,
  }),
  z.object({
    type: z.literal("heartbeat"),
    latestSequence: generationStreamSequenceSchema,
  }),
  z.object({
    type: z.literal("complete"),
    generation: generationJobSchema,
    latestSequence: generationStreamSequenceSchema,
  }),
]);

export const generationControlStatusSchema = z.enum(["enabled", "paused"]);

export const generationControlSchema = z.object({
  status: generationControlStatusSchema,
  reason: z.string().nullable(),
  updatedByUserId: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

/** An active generation job that the stale-job sweep checks. */
export const staleGenerationJobSchema = generationJobSchema.extend({
  projectName: z.string(),
  projectSlug: z.string(),
  repositoryFullName: z.string().nullable(),
  latestEvent: jobEventSchema.nullable(),
  elapsedSeconds: z.number().int().nonnegative(),
  isStale: z.boolean(),
});

/** `GET /me`: the signed-in person. */
export const currentUserSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
});

export const currentUserResponseSchema = z.object({
  user: currentUserSchema,
});

export const docsPreviewVisibilitySchema = z.enum(["private", "public"]);
export const updateDocsPreviewVisibilityInputSchema = z
  .object({
    previewVisibility: docsPreviewVisibilitySchema,
  })
  .strict();
export const docsAccessPolicySchema = z.enum(["public", "authenticated"]);

export const docsHostResolutionSchema = z.object({
  siteId: z.string(),
  projectId: z.string(),
  projectSlug: z.string(),
  publishedVersionId: z.string(),
  artifactPrefix: z.string(),
  manifestPath: z.string(),
  accessPolicy: docsAccessPolicySchema,
});

export const docsDomainKindSchema = z.enum(["doxa_subdomain", "custom_domain"]);
export const docsRenderTargetSchema = z.enum([
  "production",
  "preview",
  "generation_snapshot",
]);
export const docsDomainStatusSchema = z.enum(["active", "disabled"]);
export const docsDomainVerificationStatusSchema = z.enum([
  "pending",
  "verified",
  "failed",
]);
export const docsDomainRoutingStatusSchema = z.enum([
  "pending",
  "healthy",
  "failed",
]);
export const docsDomainProviderSchema = z.enum(["cloudflare"]);

export const docsDomainOwnershipVerificationSchema = z.object({
  type: z.string().nullable(),
  name: z.string().nullable(),
  value: z.string().nullable(),
});

export const docsDomainOwnershipVerificationHttpSchema = z.object({
  url: z.string().nullable(),
  body: z.string().nullable(),
});

export const docsDomainSslValidationRecordSchema = z.object({
  status: z.string().nullable(),
  txtName: z.string().nullable(),
  txtValue: z.string().nullable(),
  httpUrl: z.string().nullable(),
  httpBody: z.string().nullable(),
});

export const docsDomainDnsRecordSchema = z.object({
  type: z.literal("CNAME"),
  name: z.string(),
  target: z.string(),
  proxyStatus: z.literal("dns_only"),
});

export const docsDomainSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  siteId: z.string(),
  hostname: z.string(),
  kind: docsDomainKindSchema,
  status: docsDomainStatusSchema,
  verificationStatus: docsDomainVerificationStatusSchema,
  provider: docsDomainProviderSchema.nullable(),
  providerHostnameId: z.string().nullable(),
  providerStatus: z.string().nullable(),
  providerSslStatus: z.string().nullable(),
  ownershipVerification: docsDomainOwnershipVerificationSchema.nullable(),
  ownershipVerificationHttp:
    docsDomainOwnershipVerificationHttpSchema.nullable(),
  sslValidationRecords: z.array(docsDomainSslValidationRecordSchema),
  dnsRecord: docsDomainDnsRecordSchema.nullable(),
  verificationError: z.string().nullable(),
  routingStatus: docsDomainRoutingStatusSchema,
  routingHttpStatus: z.number().int().min(100).max(599).nullable(),
  routingError: z.string().nullable(),
  routingCheckedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const docsDomainCollectionSchema = z.object({
  domains: z.array(docsDomainSchema),
  customDomainLimit: z.number().int().nonnegative(),
});

export const docsDomainResolutionSchema = docsHostResolutionSchema.extend({
  hostname: z.string(),
  domainKind: docsDomainKindSchema,
  renderTarget: docsRenderTargetSchema.optional(),
});

export const createDocsDomainInputSchema = z.object({
  hostname: z.string().trim().min(1).max(253),
});

const uuidSchema = z.string().uuid();

export const publishJobInputSchema = z.object({
  artifactPrefix: z.string().min(1),
  manifestPath: z.string().min(1),
});

const completeJobOutputBaseFields = {
  versionId: uuidSchema,
  artifactPrefix: z.string().min(1),
  manifestPath: z.string().min(1),
  generationStatePrefix: z.string().min(1),
  sourceRevision: gitObjectIdSchema,
  sourceTreeHash: gitObjectIdSchema,
  baselineVersionId: uuidSchema.nullable(),
  generatorFingerprint: z.string().min(1),
  changedSourceCount: z.number().int().nonnegative(),
  regeneratedPageCount: z.number().int().nonnegative(),
  reusedPageCount: z.number().int().nonnegative(),
};

export const completeJobOutputInputSchema = z.discriminatedUnion(
  "publicationMode",
  [
    z
      .object({
        publicationMode: z.literal("publish"),
        ...completeJobOutputBaseFields,
        /** Owned pages whose sources changed; the review shows them. */
        ownedPageFlags: z.array(ownedPageFlagSchema).max(200).optional(),
        /** The files each written page read; the review cites them. */
        pageSources: z.array(pageSourcesSchema).max(500).optional(),
      })
      .strict(),
    z
      .object({
        publicationMode: z.literal("preview"),
        ...completeJobOutputBaseFields,
        provider: sourceProviderSchema,
        changeExternalId: z.string().min(1),
        changeNumber: z.number().int().positive(),
        expectedHeadRevision: gitObjectIdSchema,
        expectedPreviewVersionId: uuidSchema.nullable(),
      })
      .strict(),
  ],
);

export const completeJobOutputResultSchema = z
  .object({
    versionId: uuidSchema,
    previewUrl: z.string().url().nullable(),
  })
  .strict();

export const addJobEventInputSchema = z.object({
  type: z.string().min(1),
  message: z.string().min(1),
  source: jobEventSourceSchema.optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const generationContextSchema = z.object({
  siteConfig: siteConfigSchema.optional(),
  entitlements: projectEntitlementsSchema.optional(),
  project: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    siteId: z.string(),
    siteSlug: z.string(),
  }),
  repository: z.object({
    id: z.string(),
    fullName: z.string(),
    defaultBranch: z.string(),
    installationId: z.string(),
    isPrivate: z.boolean().optional(),
  }),
});

export const generationExecutionContextSchema = generationContextSchema.extend({
  sourceRepository: z
    .object({
      externalId: z.string().min(1),
      owner: z.string().min(1),
      name: z.string().min(1),
    })
    .strict(),
  job: z
    .object({
      id: uuidSchema,
      trigger: generationJobTriggerSchema,
      publicationMode: generationPublicationModeSchema,
      sourceProvider: sourceProviderSchema.nullable(),
      sourceInstallationExternalId: z.string().min(1).nullable(),
      changeExternalId: z.string().min(1).nullable(),
      baselineRevision: gitObjectIdSchema.nullable(),
      targetRevision: gitObjectIdSchema.nullable(),
      sourceTreeHash: gitObjectIdSchema.nullable(),
      baselineVersionId: uuidSchema.nullable(),
      agentModel: z.string().trim().min(1).nullable(),
      plannerModel: z.string().trim().min(1).nullable(),
      writerModel: z.string().trim().min(1).nullable(),
      planningFingerprint: z.string().min(1).nullable(),
      writingFingerprint: z.string().min(1).nullable(),
      generationProfile: generationProfileSchema.nullable(),
      generatorFingerprint: z.string().min(1).nullable(),
      externalReviewRunId: z.string().min(1).nullable(),
    })
    .strict(),
  changeProposal: z
    .object({
      id: uuidSchema,
      externalId: z.string().min(1),
      number: z.number().int().positive(),
      draft: z.boolean(),
      state: changeProposalStateSchema,
      baseRef: z.string().min(1),
      baseRevision: gitObjectIdSchema,
      headRevision: gitObjectIdSchema,
      repositoryExternalId: z.string().min(1),
    })
    .strict()
    .nullable(),
  baselineVersion: z
    .object({
      id: uuidSchema,
      sourceRevision: gitObjectIdSchema.nullable(),
      sourceTreeHash: gitObjectIdSchema.nullable(),
      generatorFingerprint: z.string().min(1).nullable(),
      generationStatePrefix: z.string().min(1),
    })
    .strict()
    .nullable(),
  currentPreviewVersionId: uuidSchema.nullable(),
  /**
   * The live routes of the pages that a person locked. The worker keeps them
   * as published. Absent or empty means no page is locked.
   */
  pageLocks: z
    .object({ locked: z.array(z.string().startsWith("/")) })
    .strict()
    .optional(),
  /**
   * The hand-written version that a seeded run reads. Its structure anchors
   * the plan and each page's text guides its writer.
   */
  seedVersion: z
    .object({ id: uuidSchema, artifactPrefix: z.string().min(1) })
    .strict()
    .nullable()
    .optional(),
});

export const currentChangeProposalStateSchema = z
  .object({
    externalId: z.string().min(1),
    number: z.number().int().positive(),
    draft: z.boolean(),
    state: changeProposalStateSchema,
    baseRef: z.string().min(1),
    baseRevision: gitObjectIdSchema,
    headRevision: gitObjectIdSchema,
    sourceUpdatedAt: z.string().datetime(),
  })
  .strict();

const seedNavigationNodeSchema = z.union([
  z.object({ heading: z.string().min(1) }).strict(),
  z.object({ title: z.string(), href: z.string().startsWith("/") }).strict(),
]);

/** A hand-written site, as plain navigation and page metadata. */
export const seedSiteSchema = z
  .object({
    sections: z.array(
      z
        .object({
          slug: z.string().min(1),
          label: z.string().min(1),
          isDefault: z.boolean(),
          nodes: z.array(seedNavigationNodeSchema),
        })
        .strict(),
    ),
    pages: z.array(
      z
        .object({
          href: z.string().startsWith("/"),
          title: z.string(),
          description: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

/**
 * The most pages one write stage request may carry: one write group. The
 * worker caps its group size with the same constant.
 */
export const MAX_WRITE_GROUP_PAGES = 64;

/**
 * The most pages one write group of template-rendered pages may carry.
 * Template pages make no model call, so their groups are much larger. The
 * container accepts more than `MAX_WRITE_GROUP_PAGES` pages only when every
 * page of the group is template-rendered.
 */
export const MAX_TEMPLATE_WRITE_GROUP_PAGES = 500;

export const containerGenerateRequestSchema = z.object({
  siteConfig: siteConfigSchema.optional(),
  entitlements: projectEntitlementsSchema.optional(),
  jobId: uuidSchema,
  repositoryFullName: z.string(),
  defaultBranch: z.string().optional(),
  installationAccessToken: z.string(),
  modelProvider: modelProviderSchema.default(DEFAULT_MODEL_PROVIDER),
  /** The API key of `modelProvider`. */
  modelApiKey: z.string(),
  model: z.string().optional(),
  modelConfig: generationModelConfigSchema.optional(),
  stageExecutionId: uuidSchema.optional(),
  generationProfile: generationProfileSchema.default("fast-mvp"),
  /** The most page writers the job may run at once; the container adapts below it. */
  pageConcurrency: z.number().int().min(1).max(64).optional(),
  /**
   * @deprecated The container has no total page cap and ignores this field.
   * It stays for one release, so an older worker can still call a newer container.
   */
  maxPages: z.number().int().min(1).max(200).optional(),
  siteId: z.string(),
  versionId: z.string(),
  projectSlug: z.string(),
  projectName: z.string(),
  checkoutSpec: sourceCheckoutSpecSchema.optional(),
  generatorFingerprint: z.string().trim().min(1).optional(),
  planningFingerprint: z.string().trim().min(1).optional(),
  writingFingerprint: z.string().trim().min(1).optional(),
  reusableState: reusableGenerationStateSchema.optional(),
  /**
   * The navigation of a hand-written site. The container turns it into the
   * planner's anchor when no generation baseline exists.
   */
  seedSite: seedSiteSchema.optional(),
});

export const containerAnalyzeStageRequestSchema =
  containerGenerateRequestSchema.extend({
    stage: z.literal("analysis"),
  });

export const containerPlanStageRequestSchema =
  containerGenerateRequestSchema.extend({
    stage: z.literal("plan"),
  });

export const containerStructureStageRequestSchema =
  containerGenerateRequestSchema.extend({
    stage: z.literal("structure"),
    analysisCheckpoint: z.string().min(2),
    sourceState: generationSourceStateSchema.optional(),
    analysisState: generationAnalysisStateSchema.optional(),
    preliminaryPlan: incrementalGenerationPlanSchema.optional(),
    structuralFingerprint: sha256Schema.optional(),
  });

/** The published version of a page that a writer edits, and the changed files it depends on. */
export const previousPageTextSchema = z.object({
  content: z.string(),
  changedSources: z.array(z.string().min(1)),
}).strict();

export type PreviousPageText = z.infer<typeof previousPageTextSchema>;

export const containerWriteStageRequestSchema =
  containerGenerateRequestSchema.extend({
    stage: z.literal("write"),
    analysisCheckpoint: z.string().min(2),
    structureCheckpoint: z.string().min(2),
    writerHandoff: writerHandoffManifestSchema.optional(),
    pageIds: z.array(z.string().min(1)).min(1).max(MAX_TEMPLATE_WRITE_GROUP_PAGES),
    /**
     * The hand-written page bodies of a seeded run, by route. The container
     * gives each writer only the body of its own page.
     */
    seedBodies: z.record(z.string(), z.string()).optional(),
    /**
     * The published versions of pages that the writer edits instead of
     * writing again, by page ID, with the changed files each one depends on.
     */
    previousPages: z.record(z.string(), previousPageTextSchema).optional(),
  });

export const containerGenerationStageRequestSchema = z.discriminatedUnion(
  "stage",
  [
    containerAnalyzeStageRequestSchema,
    containerPlanStageRequestSchema,
    containerStructureStageRequestSchema,
    containerWriteStageRequestSchema,
  ],
);

export const runtimeDocsNavigationSchema = z.object({
  sections: z.array(
    z.object({
      slug: z.string().min(1),
      items: z.array(z.string()),
      groups: z
        .array(
          z.object({
            heading: z.string().min(1),
            items: z.array(z.string()),
          }),
        )
        .optional(),
    }),
  ),
  icons: z.record(z.string(), z.string()).optional(),
  navTitles: z.record(z.string(), z.string()).optional(),
  navBadges: z.record(z.string(), z.string()).optional(),
  sectionMetadata: z
    .record(
      z.string(),
      z.object({
        label: z.string().min(1),
        kind: z.enum(["documentation", "reference", "development"]).optional(),
        layout: z.enum(["docs", "reference"]).optional(),
      }),
    )
    .optional(),
});

export const runtimeDocsFeaturesSchema = z
  .object({
    apiPlayground: z.boolean(),
  })
  .strict();

export const stagedRuntimePageSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  route: z.string().min(1),
  navigationPath: z.string().min(1),
  content: z.string().min(1),
  dependencies: pageDependencyStateSchema,
  contentHash: sha256Schema,
  pageInputHash: sha256Schema,
});

/** A page that a write stage could not write after its retries. */
export const failedStagePageSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  reason: z.string().min(1).max(2_000),
});

export const containerGenerationStageResultSchema = z.union([
  z.object({
    stage: z.literal("analysis"),
    checkpoint: z.string().min(2),
    snapshot: repositorySnapshotSchema.optional(),
    sourceState: generationSourceStateSchema.optional(),
    analysisState: generationAnalysisStateSchema.optional(),
    preliminaryPlan: incrementalGenerationPlanSchema.optional(),
    structuralFingerprint: sha256Schema.optional(),
  }),
  z.object({
    stage: z.literal("analysis"),
    outcome: z.literal("merge_conflict"),
    targetRevision: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    message: z.string().min(1),
  }),
  z.object({
    stage: z.literal("plan"),
    analysisCheckpoint: z.string().min(2),
    structureCheckpoint: z.string().min(2),
    pageIds: z.array(z.string().min(1)).min(1),
    pageInputHashes: z.record(z.string(), sha256Schema),
    routeRegistryHash: sha256Schema,
    navigation: runtimeDocsNavigationSchema,
    runtimeFeatures: runtimeDocsFeaturesSchema.optional(),
    writerHandoff: writerHandoffManifestSchema.optional(),
    snapshot: repositorySnapshotSchema.optional(),
    sourceState: generationSourceStateSchema.optional(),
    analysisState: generationAnalysisStateSchema.optional(),
    structureState: generationStructureStateSchema.optional(),
    preliminaryPlan: incrementalGenerationPlanSchema.optional(),
    plan: incrementalGenerationPlanSchema.optional(),
    structuralFingerprint: sha256Schema.optional(),
  }),
  z.object({
    stage: z.literal("plan"),
    outcome: z.literal("merge_conflict"),
    targetRevision: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    message: z.string().min(1),
  }),
  z.object({
    stage: z.literal("structure"),
    checkpoint: z.string().min(2),
    pageIds: z.array(z.string().min(1)).min(1),
    pageInputHashes: z.record(z.string(), sha256Schema),
    routeRegistryHash: sha256Schema,
    navigation: runtimeDocsNavigationSchema,
    runtimeFeatures: runtimeDocsFeaturesSchema.optional(),
    writerHandoff: writerHandoffManifestSchema.optional(),
    plan: incrementalGenerationPlanSchema.optional(),
    structureState: generationStructureStateSchema.optional(),
  }),
  z.object({
    stage: z.literal("write"),
    /** Empty when every page of the batch failed. */
    pages: z.array(stagedRuntimePageSchema),
    failedPages: z.array(failedStagePageSchema).default([]),
  }),
]);

export const containerArtifactFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  contentType: z.string().min(1),
});

export const containerGenerationEventSchema = z.object({
  source: jobEventSourceSchema.default("container"),
  sequence: z.number().int().positive().optional(),
  type: z.string().min(1),
  message: z.string().min(1),
  elapsedMs: z.number().int().nonnegative().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const containerGenerateResponseSchema = z.object({
  ok: z.literal(true),
  jobId: uuidSchema,
  files: z.array(containerArtifactFileSchema).min(1),
  events: z.array(containerGenerationEventSchema).default([]),
});

export const containerGenerateStreamResultSchema = z.object({
  ok: z.literal(true),
  jobId: uuidSchema,
  files: z.array(containerArtifactFileSchema).min(1),
});

export const containerGenerateHeartbeatRecordSchema = z.object({
  kind: z.literal("heartbeat"),
  elapsedMs: z.number().int().nonnegative(),
});

export const containerGenerateStreamRecordSchema = z.discriminatedUnion(
  "kind",
  [
    containerGenerateHeartbeatRecordSchema,
    z.object({
      kind: z.literal("event"),
      event: containerGenerationEventSchema,
    }),
    z.object({
      kind: z.literal("result"),
      result: containerGenerateStreamResultSchema,
    }),
    z.object({
      kind: z.literal("error"),
      error: z.object({
        message: z.string().min(1),
      }),
    }),
  ],
);

export const containerGenerationStageStreamRecordSchema = z.discriminatedUnion(
  "kind",
  [
    containerGenerateHeartbeatRecordSchema,
    z.object({
      kind: z.literal("event"),
      event: containerGenerationEventSchema,
    }),
    z.object({
      kind: z.literal("usage"),
      record: generationUsageRecordSchema,
    }),
    z.object({
      kind: z.literal("diagnostic"),
      diagnostic: generationRepairDiagnosticSchema,
    }),
    z.object({
      kind: z.literal("page_checkpoint"),
      page: stagedRuntimePageSchema,
    }),
    z.object({
      kind: z.literal("stage_result"),
      result: containerGenerationStageResultSchema,
    }),
    z.object({
      kind: z.literal("error"),
      error: z.object({
        message: z.string().min(1),
        retryable: z.boolean().default(true),
        code: z.string().min(1).optional(),
      }),
    }),
  ],
);

export interface GenerateJobMessage {
  jobId: string;
  projectId: string;
  userId: string;
  /** Continues the run's existing Workflow instance from this step instead of starting it. */
  restartFrom?: WorkflowRestartPoint;
}

export type GitHubRepositoryDto = z.infer<typeof githubRepositorySchema>;
export type ProjectDto = z.infer<typeof projectSchema>;
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
export type ExampleDocsTemplate = z.infer<typeof exampleDocsTemplateSchema>;
export type CreateExampleProjectInput = z.infer<
  typeof createExampleProjectInputSchema
>;
export type ConnectProjectRepositoryInput = z.infer<
  typeof connectProjectRepositoryInputSchema
>;
export type GenerationJobDto = z.infer<typeof generationJobSchema>;
export type GenerationStartResultDto = z.infer<
  typeof generationStartResultSchema
>;
export type GenerationConfirmationReason = z.infer<
  typeof generationConfirmationReasonSchema
>;
export type GenerationDetailDto = z.infer<typeof generationDetailSchema>;
export type GenerationAuthorDto = z.infer<typeof generationAuthorSchema>;
export type GenerationSourceDto = z.infer<typeof generationSourceSchema>;
export type GenerationDomainDto = z.infer<typeof generationDomainSchema>;
export type GenerationDeploymentDto = z.infer<
  typeof generationDeploymentSchema
>;
export type GenerationDeploymentState = z.infer<
  typeof generationDeploymentStateSchema
>;
export type GenerationActionsDto = z.infer<typeof generationActionsSchema>;
export type GenerationRerunLinksDto = z.infer<typeof generationRerunLinksSchema>;
export type GenerationActionBlockedReason = z.infer<
  typeof generationActionBlockedReasonSchema
>;
export type PromoteGenerationResult = z.infer<
  typeof promoteGenerationResultSchema
>;
export type GenerationsPageDto = z.infer<typeof generationsPageSchema>;
export type GenerationProfile = z.infer<typeof generationProfileSchema>;
export type GenerationExecutionConfig = z.infer<
  typeof generationExecutionConfigSchema
>;
export type JobEventDto = z.infer<typeof jobEventSchema>;
export type JobEventSource = z.infer<typeof jobEventSourceSchema>;
export type GenerationLogPhase = z.infer<typeof generationLogPhaseSchema>;
export type GenerationLogLevel = z.infer<typeof generationLogLevelSchema>;
export type GenerationStreamMessage = z.infer<
  typeof generationStreamMessageSchema
>;
export type ContainerGenerateHeartbeatRecord = z.infer<
  typeof containerGenerateHeartbeatRecordSchema
>;
export type GenerationControlStatus = z.infer<
  typeof generationControlStatusSchema
>;
export type GenerationControlDto = z.infer<typeof generationControlSchema>;
export type StaleGenerationJobDto = z.infer<typeof staleGenerationJobSchema>;
export type CurrentUserDto = z.infer<typeof currentUserSchema>;
export type CurrentUserResponse = z.infer<typeof currentUserResponseSchema>;
export type DocsHostResolution = z.infer<typeof docsHostResolutionSchema>;
export type DocsPreviewVisibility = z.infer<typeof docsPreviewVisibilitySchema>;
export type UpdateDocsPreviewVisibilityInput = z.infer<
  typeof updateDocsPreviewVisibilityInputSchema
>;
export type DocsAccessPolicy = z.infer<typeof docsAccessPolicySchema>;
export type DocsDomainKind = z.infer<typeof docsDomainKindSchema>;
export type DocsRenderTarget = z.infer<typeof docsRenderTargetSchema>;
export type DocsDomainStatus = z.infer<typeof docsDomainStatusSchema>;
export type DocsDomainVerificationStatus = z.infer<
  typeof docsDomainVerificationStatusSchema
>;
export type DocsDomainRoutingStatus = z.infer<
  typeof docsDomainRoutingStatusSchema
>;
export type DocsDomainProvider = z.infer<typeof docsDomainProviderSchema>;
export type DocsDomainOwnershipVerification = z.infer<
  typeof docsDomainOwnershipVerificationSchema
>;
export type DocsDomainOwnershipVerificationHttp = z.infer<
  typeof docsDomainOwnershipVerificationHttpSchema
>;
export type DocsDomainSslValidationRecord = z.infer<
  typeof docsDomainSslValidationRecordSchema
>;
export type DocsDomainDnsRecord = z.infer<typeof docsDomainDnsRecordSchema>;
export type DocsDomainDto = z.infer<typeof docsDomainSchema>;
export type DocsDomainCollectionDto = z.infer<
  typeof docsDomainCollectionSchema
>;
export type DocsDomainResolution = z.infer<typeof docsDomainResolutionSchema>;
export type CreateDocsDomainInput = z.infer<typeof createDocsDomainInputSchema>;
export type PublishJobInput = z.infer<typeof publishJobInputSchema>;
export type CompleteJobOutputInput = z.infer<
  typeof completeJobOutputInputSchema
>;
export type CompleteJobOutputResult = z.infer<
  typeof completeJobOutputResultSchema
>;
export type AddJobEventInput = z.infer<typeof addJobEventInputSchema>;
export type GenerationContext = z.infer<typeof generationContextSchema>;
export type GenerationPublicationMode = z.infer<
  typeof generationPublicationModeSchema
>;
export type GenerationExecutionContext = z.infer<
  typeof generationExecutionContextSchema
>;
export type CurrentChangeProposalState = z.infer<
  typeof currentChangeProposalStateSchema
>;
export type ContainerGenerateRequest = z.infer<
  typeof containerGenerateRequestSchema
>;
export type ContainerAnalyzeStageRequest = z.infer<
  typeof containerAnalyzeStageRequestSchema
>;
export type ContainerPlanStageRequest = z.infer<
  typeof containerPlanStageRequestSchema
>;
export type ContainerStructureStageRequest = z.infer<
  typeof containerStructureStageRequestSchema
>;
export type ContainerWriteStageRequest = z.infer<
  typeof containerWriteStageRequestSchema
>;
export type ContainerGenerationStageRequest = z.infer<
  typeof containerGenerationStageRequestSchema
>;
export type RuntimeDocsNavigation = z.infer<typeof runtimeDocsNavigationSchema>;
export type StagedRuntimePage = z.infer<typeof stagedRuntimePageSchema>;
export type FailedStagePage = z.infer<typeof failedStagePageSchema>;
export type ContainerGenerationStageResult = z.infer<
  typeof containerGenerationStageResultSchema
>;
export type ContainerGenerationStageStreamRecord = z.infer<
  typeof containerGenerationStageStreamRecordSchema
>;
export type ContainerArtifactFile = z.infer<typeof containerArtifactFileSchema>;
export type ContainerGenerationEvent = z.infer<
  typeof containerGenerationEventSchema
>;
export type ContainerGenerateResponse = z.infer<
  typeof containerGenerateResponseSchema
>;
export type ContainerGenerateStreamResult = z.infer<
  typeof containerGenerateStreamResultSchema
>;
export type ContainerGenerateStreamRecord = z.infer<
  typeof containerGenerateStreamRecordSchema
>;

export interface InternalApiRpc {
  resolveDocsSite(projectSlug: string): Promise<DocsHostResolution | null>;
  resolveDocsProject(projectId: string): Promise<DocsHostResolution | null>;
  resolveDocsHost(hostname: string): Promise<DocsDomainResolution | null>;
  readDocsArtifact(
    path: string,
  ): Promise<{ text: string; contentType: string } | null>;
  getGenerationContext(projectId: string): Promise<GenerationContext | null>;
  getGenerationExecutionContext(
    jobId: string,
  ): Promise<GenerationExecutionContext | null>;
  getCurrentChangeProposalState(
    jobId: string,
  ): Promise<CurrentChangeProposalState | null>;
  createInstallationAccessToken(installationId: string): Promise<string>;
  markJobRunning(jobId: string): Promise<void>;
  markJobFailed(jobId: string, message: string): Promise<void>;
  markJobCancelled(jobId: string, message: string): Promise<void>;
  markJobSuperseded(jobId: string, message: string): Promise<void>;
  isJobActive(jobId: string): Promise<boolean>;
  /** When a person last continued the failed run, or null. Its time budget starts there. */
  getGenerationResumedAt(jobId: string): Promise<string | null>;
  getGenerationControl(): Promise<GenerationControlDto>;
  listStaleGenerationJobs(input: {
    queuedStaleSeconds: number;
    runningStaleSeconds: number;
  }): Promise<StaleGenerationJobDto[]>;
  addJobEvent(jobId: string, input: AddJobEventInput): Promise<JobEventDto>;
  getGenerationDatabaseCompatibility(): Promise<GenerationDatabaseCompatibility>;
  recordGenerationUsage(record: GenerationUsageRecord): Promise<void>;
  recordGenerationDiagnostic(
    diagnostic: GenerationRepairDiagnostic,
    draftKey: string,
  ): Promise<void>;
  getGenerationUsageSummary(
    jobId: string,
  ): Promise<GenerationUsageSummary | null>;
  /** Deletes expired repair diagnostics. Usage rows are kept for billing. */
  deleteExpiredGenerationObservability(
    nowIso: string,
    limit: number,
  ): Promise<{ diagnostics: number }>;
  publishJobOutput(
    jobId: string,
    input: PublishJobInput,
  ): Promise<{ versionId: string }>;
  completeJobOutput(
    jobId: string,
    input: CompleteJobOutputInput,
  ): Promise<CompleteJobOutputResult>;
  createReviewRun(
    jobId: string,
    input: CreateReviewRunInput,
  ): Promise<ReviewRunResult>;
  updateReviewRun(
    jobId: string,
    input: UpdateReviewRunInput,
  ): Promise<ReviewRunResult>;
}
export * from "./docs-cache";

export type SeedSite = z.infer<typeof seedSiteSchema>;
export type GenerationJobTrigger = z.infer<typeof generationJobTriggerSchema>;
