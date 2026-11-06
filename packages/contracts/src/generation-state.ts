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
  /**
   * The project instructions fingerprint that the page was written with. A
   * page that a run kept keeps its older value, so a later run edits it to
   * follow the current instructions. Absent on pages written before the
   * field: they follow the run-level fingerprint of their state.
   */
  projectInstructionsFingerprint: z.string().trim().min(1).optional(),
}).strict();

/** The failed catch-up runs after which a page stays behind the instructions. */
export const MAX_INSTRUCTION_CATCH_UP_ATTEMPTS = 3;

/** Bounds the manifest list; a site with more behind pages lists the first ones. */
export const MAX_BEHIND_INSTRUCTION_PAGE_IDS = 1_000;

/**
 * How many runs in a row failed to bring each page up to one instructions
 * fingerprint. One object per site, outside the published state, because a
 * run whose only work is a failed catch-up publishes nothing and must still
 * count. A ledger for another fingerprint counts as empty, so new
 * instructions give every page new attempts.
 */
export const instructionCatchUpLedgerSchema = z.object({
  schemaVersion: z.literal(1),
  instructionsFingerprint: z.string().trim().min(1),
  /** The job that wrote the ledger last, so a retried step does not count twice. */
  lastJobId: z.string().trim().min(1),
  attempts: z.record(
    z.string().trim().min(1),
    z.number().int().min(1).max(MAX_INSTRUCTION_CATCH_UP_ATTEMPTS),
  ),
}).strict();

export type InstructionCatchUpLedger = z.infer<typeof instructionCatchUpLedgerSchema>;

/** Where a site keeps its catch-up ledger; the deleted-site collector removes it with the site. */
export function instructionCatchUpLedgerKey(siteId: string): string {
  return `sites/${siteId}/generation-state/instruction-catch-up.json`;
}

/** The ledger in a stored object, or null when it is missing or malformed. */
export function parseInstructionCatchUpLedger(value: unknown): InstructionCatchUpLedger | null {
  const parsed = instructionCatchUpLedgerSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The pages that runs no longer try to bring up to these instructions. */
export function exhaustedCatchUpPageIds(
  ledger: InstructionCatchUpLedger | null | undefined,
  instructionsFingerprint: string,
): Set<string> {
  if (!ledger || ledger.instructionsFingerprint !== instructionsFingerprint) return new Set();
  return new Set(Object.entries(ledger.attempts)
    .filter(([, attempts]) => attempts >= MAX_INSTRUCTION_CATCH_UP_ATTEMPTS)
    .map(([pageId]) => pageId));
}

/**
 * The ledger after one run. Each failed catch-up page counts one more.
 * Entries for pages that are no longer behind the instructions in the
 * published state, or no longer in the structure, leave the ledger: a page
 * that a run wrote is still behind until its version is published, so a
 * write neither counts nor resets. A ledger for other instructions starts
 * again from empty. Null when nothing changes, including a second write by
 * the same job.
 */
export function nextInstructionCatchUpLedger(input: {
  ledger: InstructionCatchUpLedger | null | undefined;
  instructionsFingerprint: string;
  jobId: string;
  catchUpPageIds: readonly string[];
  failedPageIds: ReadonlySet<string>;
  /** The pages still behind the instructions in the published state and in this run's structure. */
  behindPageIds: ReadonlySet<string>;
}): InstructionCatchUpLedger | null {
  const forOtherInstructions = input.ledger !== null && input.ledger !== undefined
    && input.ledger.instructionsFingerprint !== input.instructionsFingerprint;
  const current = forOtherInstructions ? null : input.ledger ?? null;
  if (current?.lastJobId === input.jobId) return null;

  const attempts: Record<string, number> = Object.fromEntries(
    Object.entries(current?.attempts ?? {}).filter(([pageId]) => input.behindPageIds.has(pageId)),
  );
  for (const pageId of input.catchUpPageIds) {
    if (!input.failedPageIds.has(pageId)) continue;
    attempts[pageId] = Math.min((attempts[pageId] ?? 0) + 1, MAX_INSTRUCTION_CATCH_UP_ATTEMPTS);
  }
  const sorted = sortedRecord(attempts);
  const unchanged = JSON.stringify(sorted) === JSON.stringify(sortedRecord(current?.attempts ?? {}));
  if (unchanged && !forOtherInstructions) return null;
  return {
    schemaVersion: 1,
    instructionsFingerprint: input.instructionsFingerprint,
    lastJobId: input.jobId,
    attempts: sorted,
  };
}

function sortedRecord(record: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

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
  /**
   * The pages that this state keeps behind its project instructions and that
   * a later run writes again, so the admission check knows that a run has
   * work although nothing else changed. Locked pages are left out. Pages that
   * ran out of catch-up attempts are left out when the admission check reads
   * the catch-up ledger. Absent on older states and when no page is behind.
   */
  behindInstructionPageIds: z.array(z.string().trim().min(1)).max(MAX_BEHIND_INSTRUCTION_PAGE_IDS).optional(),
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
   * Owned pages for the review: kept although their sources or the project
   * instructions changed (each one in `reusePageIds`), or left out because
   * the new plan has no page for them (each one in `removedPageIds`).
   */
  ownedPageFlags: z.array(z.object({
    pageId: z.string().trim().min(1),
    changedPaths: z.array(z.string().min(1)),
    /** The page may not follow the current project instructions. */
    instructionsChanged: z.literal(true).optional(),
    /** The new plan has no page for it, so the run left it out. */
    removed: z.literal(true).optional(),
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
  /**
   * Regenerated pages that the run writes only to bring them up to the
   * current instructions, after an earlier run kept them. A failure among
   * them never counts toward the page failure budget of the run.
   */
  catchUpPageIds: orderedUniqueStringsSchema.optional(),
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
  const removed = new Set(plan.removedPageIds);
  if (plan.ownedPageFlags?.some((flag) =>
    flag.removed ? !removed.has(flag.pageId) : !reused.has(flag.pageId)
  )) {
    context.addIssue({
      code: "custom",
      message: "A flagged owned page must be reused, or removed when the flag says so.",
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
  /**
   * The site's catch-up ledger, read with the published state. It is not
   * part of the published state: unpublished runs update it too.
   */
  instructionCatchUp: instructionCatchUpLedgerSchema.optional(),
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
