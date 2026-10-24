import { z } from "zod";
import { docsAssetContentTypeSchema } from "./docs-assets";
import {
  branchNameSchema,
  branchRefSchema,
  branchIdSchema,
  siteIdSchema,
  versionIdSchema,
  docsBranchPurposeSchema,
  docsPublicationKindSchema,
} from "./docs-branch-primitives";

export {
  branchNameSchema,
  validateBranchName,
  branchRefSchema,
  branchIdSchema,
  siteIdSchema,
  versionIdSchema,
  docsBranchKindSchema,
  docsBranchPurposeSchema,
  docsBranchChangeKindSchema,
  docsPublicationKindSchema,
  branchPathSchema,
  classifyBranchPath,
  type BranchPathKind,
  relativeNavigationPathForSection,
  documentSectionSlugFromRelativePath,
} from "./docs-branch-primitives";

export const docsPublicationSummarySchema = z
  .object({
    changedPageCount: z.number().int().nonnegative().optional(),
    pageTitles: z.array(z.string().max(200)).max(20).optional(),
    structureChanged: z.boolean().optional(),
    siteSettingsChanged: z.boolean().optional(),
    restoredPublicationId: z.uuid().optional(),
  })
  .strict();

/**
 * Who created a named branch: a person in the dashboard, or an agent through
 * MCP. Only the same OAuth client, acting for the same member, may delete an
 * agent branch. `userId` is the member the agent acted for, not the project
 * owner; it is null once that member's account is deleted.
 */
export const docsBranchCreatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }).strict(),
  z
    .object({
      kind: z.literal("agent"),
      clientId: z.string().min(1),
      clientName: z.string().min(1),
      userId: z.string().min(1).nullable(),
    })
    .strict(),
]);

export const docsBranchSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: z.uuid(),
      kind: z.literal("named"),
      name: branchNameSchema,
      purpose: docsBranchPurposeSchema,
      baseVersionId: z.uuid(),
      createdFromBranchId: z.uuid().nullable(),
      createdBy: docsBranchCreatorSchema,
      revision: z.number().int().nonnegative(),
      changeCount: z.number().int().nonnegative(),
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      id: z.uuid(),
      kind: z.literal("hidden"),
      name: z.null(),
      baseVersionId: z.uuid(),
      createdFromBranchId: z.null(),
      revision: z.number().int().nonnegative(),
      changeCount: z.number().int().nonnegative(),
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
    })
    .strict(),
]);

export const docsBranchListSchema = z
  .object({
    branches: z.array(docsBranchSchema),
    maxBranchesPerSite: z.number().int().positive(),
  })
  .strict();

export const createDocsBranchInputSchema = z
  .object({
    name: branchNameSchema,
    from: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("main") }).strict(),
      z.object({ kind: z.literal("branch"), branchId: z.uuid() }).strict(),
    ]),
  })
  .strict();
export const renameDocsBranchInputSchema = z
  .object({ name: branchNameSchema })
  .strict();

export const conflictResolutionSchema = z.enum(["mine", "main"]);
const pageConflictKeySchema = z
  .string()
  .regex(
    /^page:\/(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*)?$/,
  );
export const conflictKeySchema = z.union([
  z.literal("structure"),
  z.literal("site_settings"),
  pageConflictKeySchema,
]);
export const docsConflictSchema = z.discriminatedUnion("unit", [
  z
    .object({
      unit: z.literal("page"),
      key: pageConflictKeySchema,
      href: z.string().startsWith("/"),
      title: z.string(),
      mine: z.enum(["modified", "deleted"]),
      main: z.enum(["modified", "deleted"]),
    })
    .strict(),
  z
    .object({ unit: z.literal("structure"), key: z.literal("structure") })
    .strict(),
  z
    .object({
      unit: z.literal("site_settings"),
      key: z.literal("site_settings"),
    })
    .strict(),
]);
export const docsSyncPreviewSchema = z
  .object({
    mainVersionId: z.uuid(),
    behind: z.boolean(),
    conflicts: z.array(docsConflictSchema),
    autoResolvedCount: z.number().int().nonnegative(),
  })
  .strict();
export const syncDocsBranchInputSchema = z
  .object({
    expectedMainVersionId: z.uuid(),
    resolutions: z.array(
      z
        .object({
          key: conflictKeySchema,
          resolution: conflictResolutionSchema,
        })
        .strict(),
    ),
    defaultResolution: conflictResolutionSchema.optional(),
  })
  .strict();
const structureDiffSideSchema = z
  .object({
    pages: z.array(z.object({ href: z.string(), title: z.string() }).strict()),
    navigationTitles: z.array(z.string()),
  })
  .strict();
export const docsConflictDiffSchema = z.discriminatedUnion("unit", [
  z
    .object({
      unit: z.literal("page"),
      key: pageConflictKeySchema,
      base: z.string().nullable(),
      main: z.string().nullable(),
      mine: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      unit: z.literal("site_settings"),
      key: z.literal("site_settings"),
      base: z.string().nullable(),
      main: z.string().nullable(),
      mine: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      unit: z.literal("structure"),
      key: z.literal("structure"),
      base: structureDiffSideSchema,
      main: structureDiffSideSchema,
      mine: structureDiffSideSchema,
    })
    .strict(),
]);

export const docsConflictDiffQuerySchema = z
  .object({ key: conflictKeySchema })
  .strict();
export const discardDocsBranchResultSchema = z
  .object({ revision: z.number().int().nonnegative() })
  .strict();
export const docsBranchPreviewResultSchema = z
  .object({
    url: z.url(),
    hostname: z.string().min(1),
    versionId: z.uuid(),
  })
  .strict();
export const docsPublicationListQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().max(25).default(25),
  })
  .strict();

/**
 * `expectedRevision` is the branch revision the user reviewed. A write that
 * lands after the review, from an agent for example, rejects the publish.
 */
export const publishDocsBranchInputSchema = z
  .object({
    expectedBaseVersionId: z.uuid(),
    expectedRevision: z.number().int().nonnegative(),
    eraseBranch: z.boolean(),
  })
  .strict();
export const publishDocsBranchResultSchema = z
  .object({
    versionId: z.uuid(),
    versionNumber: z.number().int().positive(),
    publicationId: z.uuid(),
    branchErased: z.boolean(),
  })
  .strict();

/**
 * The server stages of a publish, in order: checks, the new version files,
 * then the commit with the cache purge. The result event means "live".
 */
export const docsPublishStageSchema = z.enum([
  "preparing",
  "building",
  "optimizing",
]);

/**
 * One event of a publish request sent with `accept: text/event-stream`. The
 * SSE event name equals `type`. An `error` event carries the HTTP status and
 * the JSON body that the plain request returns for the same failure.
 */
export const publishDocsBranchEventSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("stage"), stage: docsPublishStageSchema })
    .strict(),
  z
    .object({ type: z.literal("result"), result: publishDocsBranchResultSchema })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      status: z.number().int().min(400).max(599),
      body: z.unknown(),
    })
    .strict(),
]);

export const docsPublicationAgentSchema = z
  .object({
    clientName: z.string(),
    approvalRequestId: z.uuid().nullable(),
  })
  .strict();
export const docsPublicationSchema = z
  .object({
    id: z.uuid(),
    kind: docsPublicationKindSchema,
    versionId: z.uuid(),
    versionNumber: z.number().int().positive(),
    actor: z.object({ id: z.string(), name: z.string() }).strict().nullable(),
    branchName: z.string().nullable(),
    summary: docsPublicationSummarySchema,
    /**
     * Set when an agent published. Optional so older responses and fixtures
     * stay valid; readers treat a missing value as null.
     */
    agent: docsPublicationAgentSchema.nullable().optional(),
    createdAt: z.iso.datetime(),
    isCurrent: z.boolean(),
    canRestore: z.boolean(),
    /**
     * The retention policy deleted the files of the version. The publication
     * stays in the history, but it can no longer be restored. Optional so
     * older responses and fixtures stay valid; readers treat a missing value
     * as false.
     */
    noLongerRestorable: z.boolean().optional(),
  })
  .strict();
export const docsPublicationPageSchema = z
  .object({
    publications: z.array(docsPublicationSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export const restoreDocsPublicationInputSchema = z
  .object({
    expectedMainVersionId: z.uuid(),
  })
  .strict();

export const docsBranchFileChangeSchema = z.enum([
  "added",
  "edited",
  "deleted",
]);

/** The most lines of one unified diff in a branch diff. */
export const DOCS_BRANCH_DIFF_MAX_LINES = 200;

/**
 * A unified diff of one file, from the branch base to the branch. `lineCount`
 * counts the full diff; `truncated` says that `diff` holds only the first
 * `DOCS_BRANCH_DIFF_MAX_LINES` lines of it.
 */
const fileDiffFields = {
  change: docsBranchFileChangeSchema,
  diff: z.string(),
  lineCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
};

export const docsBranchPageDiffSchema = z
  .object({
    href: z.string().startsWith("/"),
    title: z.string(),
    ...fileDiffFields,
  })
  .strict();

export const docsBranchStructureDiffSchema = z
  .object({
    path: z.string(),
    /** What the file holds, for example "Navigation (guides)". */
    label: z.string(),
    ...fileDiffFields,
  })
  .strict();

export const docsBranchSettingsDiffSchema = z
  .object(fileDiffFields)
  .strict();

/**
 * An image that the branch adds or replaces. Binary files have no text diff;
 * `path` is the path that pages use for the image.
 */
export const docsBranchAssetDiffSchema = z
  .object({
    path: z.string().startsWith("/assets/"),
    change: docsBranchFileChangeSchema,
    contentType: docsAssetContentTypeSchema,
    size: z.number().int().nonnegative(),
  })
  .strict();

/**
 * What publishing the branch changes. The diff compares the branch with its
 * base version, the main version the branch started from or last
 * synchronized with. `behind` says main has moved on since.
 */
export const docsBranchDiffSchema = z
  .object({
    baseVersionId: z.uuid(),
    mainVersionId: z.uuid(),
    behind: z.boolean(),
    pages: z.array(docsBranchPageDiffSchema),
    structure: z.array(docsBranchStructureDiffSchema),
    siteSettings: docsBranchSettingsDiffSchema.nullable(),
    assets: z.array(docsBranchAssetDiffSchema),
  })
  .strict();

export const docsBranchPageDiffQuerySchema = z
  .object({ href: z.string().startsWith("/").max(512) })
  .strict();

/** Both full sources of one changed page, for a side-by-side view. */
export const docsBranchPageSourcesSchema = z
  .object({
    href: z.string().startsWith("/"),
    title: z.string(),
    change: docsBranchFileChangeSchema,
    /** The source on the branch base; null for an added page. */
    before: z.string().nullable(),
    /** The source on the branch; null for a deleted page. */
    after: z.string().nullable(),
  })
  .strict();

export const docsBranchStatusSchema = z
  .object({
    branch: z.discriminatedUnion("kind", [
      z
        .object({
          id: z.uuid(),
          kind: z.literal("named"),
          name: branchNameSchema,
          revision: z.number().int().nonnegative(),
        })
        .strict(),
      z
        .object({
          id: z.uuid().nullable(),
          kind: z.literal("hidden"),
          name: z.null(),
          revision: z.number().int().nonnegative(),
        })
        .strict(),
    ]),
    baseVersionId: z.uuid(),
    main: z
      .object({
        versionId: z.uuid(),
        versionNumber: z.number().int().positive(),
        latestPublication: z
          .object({
            kind: docsPublicationKindSchema,
            actorName: z.string().nullable(),
            createdAt: z.iso.datetime(),
          })
          .strict(),
      })
      .strict(),
    behind: z.boolean(),
    publicationsSinceBase: z.number().int().nonnegative(),
    changeCount: z.number().int().nonnegative(),
    preview: z
      .object({ hostname: z.string(), upToDate: z.boolean() })
      .strict()
      .nullable(),
  })
  .strict();

export type BranchRef = z.infer<typeof branchRefSchema>;
export type BranchId = z.infer<typeof branchIdSchema>;
export type SiteId = z.infer<typeof siteIdSchema>;
export type VersionId = z.infer<typeof versionIdSchema>;
export type DocsBranch = z.infer<typeof docsBranchSchema>;
export type NamedDocsBranch = Extract<DocsBranch, { kind: "named" }>;
export type DocsBranchList = z.infer<typeof docsBranchListSchema>;
export type CreateDocsBranchInput = z.infer<typeof createDocsBranchInputSchema>;
export type RenameDocsBranchInput = z.infer<typeof renameDocsBranchInputSchema>;
export type DocsPublicationKind = z.infer<typeof docsPublicationKindSchema>;
export type DocsPublicationSummary = z.infer<
  typeof docsPublicationSummarySchema
>;
export type DocsConflict = z.infer<typeof docsConflictSchema>;
export type DocsConflictDiff = z.infer<typeof docsConflictDiffSchema>;
export type DocsSyncPreview = z.infer<typeof docsSyncPreviewSchema>;
export type SyncDocsBranchInput = z.infer<typeof syncDocsBranchInputSchema>;
export type PublishDocsBranchInput = z.infer<
  typeof publishDocsBranchInputSchema
>;
export type DocsPublishStage = z.infer<typeof docsPublishStageSchema>;
export type PublishDocsBranchEvent = z.infer<
  typeof publishDocsBranchEventSchema
>;
export type PublishDocsBranchResult = z.infer<
  typeof publishDocsBranchResultSchema
>;
export type DocsPublication = z.infer<typeof docsPublicationSchema>;
export type DocsPublicationPage = z.infer<typeof docsPublicationPageSchema>;
export type DocsBranchPreviewResult = z.infer<
  typeof docsBranchPreviewResultSchema
>;
export type DocsBranchStatus = z.infer<typeof docsBranchStatusSchema>;
export type DocsBranchCreator = z.infer<typeof docsBranchCreatorSchema>;
export type DocsBranchFileChange = z.infer<typeof docsBranchFileChangeSchema>;
export type DocsBranchPageDiff = z.infer<typeof docsBranchPageDiffSchema>;
export type DocsBranchStructureDiff = z.infer<
  typeof docsBranchStructureDiffSchema
>;
export type DocsBranchSettingsDiff = z.infer<
  typeof docsBranchSettingsDiffSchema
>;
export type DocsBranchAssetDiff = z.infer<typeof docsBranchAssetDiffSchema>;
export type DocsBranchDiff = z.infer<typeof docsBranchDiffSchema>;
export type DocsBranchPageSources = z.infer<typeof docsBranchPageSourcesSchema>;
