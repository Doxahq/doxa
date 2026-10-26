import { z } from "zod";
import { gitObjectIdSchema } from "./source-control";
import { normalizedSourcePathSchema } from "./source-checkout";

export const GENERATION_STATE_SCHEMA_VERSION = 1 as const;

export const sha256Schema = z.string().regex(
  /^[0-9a-f]{64}$/,
  "Expected a lowercase hexadecimal SHA-256 hash.",
);

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export function toJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Value cannot be represented as JSON.");
  }
  return jsonValueSchema.parse(JSON.parse(serialized));
}

const versionedStateSchema = z.object({
  schemaVersion: z.literal(GENERATION_STATE_SCHEMA_VERSION),
}).strict();

const sortedSourcePathsSchema = z.array(normalizedSourcePathSchema).superRefine(
  (paths, context) => {
    if (!isSortedUnique(paths)) {
      context.addIssue({
        code: "custom",
        message: "Source paths must be unique and deterministically ordered.",
      });
    }
  },
);

const sortedStringsSchema = z.array(z.string().trim().min(1)).superRefine(
  (values, context) => {
    if (!isSortedUnique(values)) {
      context.addIssue({
        code: "custom",
        message: "Values must be unique and deterministically ordered.",
      });
    }
  },
);

export const sourceFileHashSchema = z.object({
  path: normalizedSourcePathSchema,
  contentHash: sha256Schema,
  contentKind: z.enum(["text", "binary"]),
}).strict();

export const generationSourceStateSchema = versionedStateSchema.extend({
  sourceRevision: gitObjectIdSchema,
  sourceTreeHash: gitObjectIdSchema,
  files: z.array(sourceFileHashSchema).superRefine((files, context) => {
    if (!isSortedUnique(files.map((file) => file.path))) {
      context.addIssue({
        code: "custom",
        message: "Source files must be unique and deterministically ordered.",
      });
    }
  }),
}).strict();

export const reusableSourceSummarySchema = z.object({
  path: normalizedSourcePathSchema,
  contentHash: sha256Schema,
  summary: jsonValueSchema,
}).strict();

export const generationAnalysisStateSchema = versionedStateSchema.extend({
  analysis: jsonValueSchema,
  analysisHash: sha256Schema,
  documentationBriefFingerprint: z.string().trim().min(1).optional(),
  /**
   * The project instructions the analysis was made with ("none" without
   * instructions). A change rewrites every page. Older states lack it, which
   * reads as "none".
   */
  projectInstructionsFingerprint: z.string().trim().min(1).optional(),
  sourceSummaries: z.array(reusableSourceSummarySchema).superRefine(
    (summaries, context) => {
      if (!isSortedUnique(summaries.map((summary) => summary.path))) {
        context.addIssue({
          code: "custom",
          message: "Source summaries must be unique and deterministically ordered.",
        });
      }
    },
  ),
}).strict();

export const generationStructureStateSchema = versionedStateSchema.extend({
  structure: jsonValueSchema,
  structureHash: sha256Schema,
  structuralFingerprint: sha256Schema,
}).strict();

export const pageDependencyStateSchema = z.object({
  sourceFilesRead: sortedSourcePathsSchema,
  sourceFilesDiscovered: sortedSourcePathsSchema,
  sourceEvidenceFiles: sortedSourcePathsSchema,
  referencedSymbols: sortedStringsSchema,
  referencedRoutes: sortedStringsSchema,
}).strict();

export const generationPageStateSchema = versionedStateSchema.extend({
  pageId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  route: z.string().trim().min(1),
  navigationPath: normalizedSourcePathSchema,
  artifactKey: normalizedSourcePathSchema,
  contentHash: sha256Schema,
  pageInputHash: sha256Schema,
  dependencies: pageDependencyStateSchema,
  /**
   * The documentation brief that the page was written with. A change of
   * project instructions finds the pages written with older ones. Absent on
   * pages written before the field existed.
   */
  briefFingerprint: z.string().trim().min(1).optional(),
}).strict();

export const generationStateObjectReferenceSchema = z.object({
  key: normalizedSourcePathSchema,
  hash: sha256Schema,
}).strict();

export const generationStateManifestPageSchema = z.object({
  pageId: z.string().trim().min(1),
  record: generationStateObjectReferenceSchema,
  artifactKey: normalizedSourcePathSchema,
  contentHash: sha256Schema,
}).strict();

export const generationStateManifestSchema = versionedStateSchema.extend({
  siteId: z.string().trim().min(1),
  versionId: z.string().trim().min(1),
  baselineVersionId: z.string().trim().min(1).nullable(),
  generatorFingerprint: z.string().trim().min(1),
  planningFingerprint: z.string().trim().min(1).optional(),
  writingFingerprint: z.string().trim().min(1).optional(),
  sourceRevision: gitObjectIdSchema,
  sourceTreeHash: gitObjectIdSchema,
  source: generationStateObjectReferenceSchema,
  analysis: generationStateObjectReferenceSchema,
  structure: generationStateObjectReferenceSchema,
  pages: z.array(generationStateManifestPageSchema).superRefine(
    (pages, context) => {
      if (!isSortedUnique(pages.map((page) => page.pageId))) {
        context.addIssue({
          code: "custom",
          message: "Manifest pages must be unique and deterministically ordered.",
        });
      }
    },
  ),
  createdAt: z.string().datetime(),
}).strict();

const orderedUniqueStringsSchema = z.array(z.string().trim().min(1))
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: "custom",
        message: "Page IDs must be unique while preserving structure order.",
      });
    }
  });

export const incrementalGenerationPlanSchema = z.object({
  analysisMode: z.enum(["reuse", "incremental", "full"]),
  structureMode: z.enum(["reuse", "patch", "regenerate"]),
  regeneratePageIds: orderedUniqueStringsSchema,
  reusePageIds: orderedUniqueStringsSchema,
  removedPageIds: orderedUniqueStringsSchema,
  modelCallsRequired: z.boolean(),
  reasons: z.array(z.string().trim().min(1)).min(1),
  causes: z.object({
    newPages: z.number().int().nonnegative(),
    inputChanged: z.number().int().nonnegative(),
    dependencyChanged: z.number().int().nonnegative(),
    /** Pages written again only because the project instructions changed. */
    instructionsChanged: z.number().int().nonnegative().optional(),
  }).strict().optional(),
  /**
   * Owned pages that the run kept although their sources changed. Each one
   * is in `reusePageIds`.
   */
  ownedPageFlags: z.array(z.object({
    pageId: z.string().trim().min(1),
    changedPaths: z.array(z.string().min(1)),
  }).strict()).optional(),
  /**
   * Regenerated pages that the baseline already has, by page ID: where the
   * published page is stored and which changed files it depends on. The
   * writer edits these pages instead of writing them again. A plan that
   * rewrites every page, for example after a contract change, has none.
   */
  pageEdits: z.record(z.string().min(1), z.object({
    artifactKey: z.string().min(1),
    changedSources: z.array(z.string().min(1)),
    /** The project instructions changed: the writer updates the page to follow them. */
    instructionsChanged: z.boolean().optional(),
  }).strict()).optional(),
  /**
   * Why a plan that rewrites every page still edits the pages the baseline
   * has: the project instructions changed, so each page keeps its text and
   * changes only where the instructions ask.
   */
  editReason: z.literal("instructions_changed").optional(),
}).strict().superRefine((plan, context) => {
  const activeIds = [
    ...plan.regeneratePageIds,
    ...plan.reusePageIds,
  ];
  if (new Set(activeIds).size !== activeIds.length) {
    context.addIssue({
      code: "custom",
      message: "A page cannot be both regenerated and reused.",
    });
  }
  const reused = new Set(plan.reusePageIds);
  if (plan.ownedPageFlags?.some((flag) => !reused.has(flag.pageId))) {
    context.addIssue({
      code: "custom",
      message: "A flagged owned page must be reused.",
      path: ["ownedPageFlags"],
    });
  }
  if (!plan.modelCallsRequired && plan.regeneratePageIds.length > 0) {
    context.addIssue({
      code: "custom",
      message: "Regenerated pages require model calls.",
      path: ["modelCallsRequired"],
    });
  }
  if (plan.causes) {
    const classifiedPageCount =
      plan.causes.newPages +
      plan.causes.inputChanged +
      plan.causes.dependencyChanged +
      (plan.causes.instructionsChanged ?? 0);
    if (classifiedPageCount !== plan.regeneratePageIds.length) {
      context.addIssue({
        code: "custom",
        message: "Regeneration causes must classify every regenerated page.",
        path: ["causes"],
      });
    }
  }
});

export const reusableGenerationStateSchema = z.object({
  manifest: generationStateManifestSchema,
  source: generationSourceStateSchema,
  analysis: generationAnalysisStateSchema,
  structure: generationStructureStateSchema,
  pages: z.array(generationPageStateSchema),
}).strict();

export type SourceFileHash = z.infer<typeof sourceFileHashSchema>;
export type GenerationSourceState = z.infer<
  typeof generationSourceStateSchema
>;
export type ReusableSourceSummary = z.infer<
  typeof reusableSourceSummarySchema
>;
export type GenerationAnalysisState = z.infer<
  typeof generationAnalysisStateSchema
>;
export type GenerationStructureState = z.infer<
  typeof generationStructureStateSchema
>;
export type PageDependencyState = z.infer<
  typeof pageDependencyStateSchema
>;
export type GenerationPageState = z.infer<
  typeof generationPageStateSchema
>;
export type GenerationStateObjectReference = z.infer<
  typeof generationStateObjectReferenceSchema
>;
export type GenerationStateManifestPage = z.infer<
  typeof generationStateManifestPageSchema
>;
export type GenerationStateManifest = z.infer<
  typeof generationStateManifestSchema
>;
export type IncrementalGenerationPlan = z.infer<
  typeof incrementalGenerationPlanSchema
>;
export type ReusableGenerationState = z.infer<
  typeof reusableGenerationStateSchema
>;

export function emptyPageDependencyState(): PageDependencyState {
  return {
    sourceFilesRead: [],
    sourceFilesDiscovered: [],
    sourceEvidenceFiles: [],
    referencedSymbols: [],
    referencedRoutes: [],
  };
}

function isSortedUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1] >= values[index]) {
      return false;
    }
  }
  return true;
}
