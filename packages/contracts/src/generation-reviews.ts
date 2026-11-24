import { z } from "zod";
import { branchNameSchema } from "./docs-branch-primitives";

export const generationReviewStatusSchema = z.enum([
  "open",
  "published",
  "discarded",
]);

/** The most source files that a review shows for one page. */
export const MAX_SOURCE_PATHS = 12;

/** The source files that a run's writer read for one page. */
export const pageSourcesSchema = z
  .object({
    href: z.string().startsWith("/").max(512),
    paths: z.array(z.string().min(1)).max(MAX_SOURCE_PATHS),
  })
  .strict();

/**
 * The MDX comment in which a seeded writer lists statements of the
 * hand-written page that the source contradicts. MDX renders nothing for a
 * comment, and the review strips it before the page goes to the branch.
 */
export const SEED_CONFLICTS_MARKER = "doxa-seed-conflicts";

const SEED_CONFLICTS_BLOCK = new RegExp(
  `\\n*\\{\\/\\*\\s*${SEED_CONFLICTS_MARKER}\\b([\\s\\S]*?)\\*\\/\\}\\s*$`,
);

/** The comment that lists seed conflicts, as a writer must emit it. */
export function formatSeedConflicts(conflicts: readonly string[]): string {
  const items = conflicts.map((item) => `- ${item}`).join("\n");
  return `{/* ${SEED_CONFLICTS_MARKER}\n${items}\n*/}`;
}

/**
 * Splits a generated page into its content and the seed conflicts that its
 * writer listed in a trailing comment. A page without the comment has none.
 */
export function extractSeedConflicts(body: string): {
  content: string;
  conflicts: string[];
} {
  const match = SEED_CONFLICTS_BLOCK.exec(body);
  if (!match) return { content: body, conflicts: [] };

  const conflicts = (match[1] ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, 20)
    .map((line) => line.slice(0, 500));
  return { content: `${body.slice(0, match.index).trimEnd()}\n`, conflicts };
}

/** What the generation does to a page, compared with the published site. */
export const generationReviewPageChangeSchema = z.enum([
  "added",
  "modified",
  "removed",
]);

export const generationReviewPageDecisionSchema = z.enum([
  "pending",
  "accepted",
  "rejected",
]);

/**
 * The decisions a person can make. A page starts with the generation's
 * change, so a new review never stores `pending`. Older reviews can hold it
 * for a removal: the review branch keeps that page.
 */
export const generationReviewDecisionSchema = z.enum(["accepted", "rejected"]);

/**
 * What a person sends for a page: a decision, or `undecided` to take a
 * decision back. An undecided page returns to the generation's change.
 */
export const generationReviewDecisionInputSchema = z.enum([
  ...generationReviewDecisionSchema.options,
  "undecided",
]);

/**
 * Why a page is in the review. Readers must accept every kind, and later
 * versions only add kinds, so an old review stays readable.
 */
export const generationReviewReasonSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new_page") }).strict(),
  z.object({ kind: z.literal("content_rewritten") }).strict(),
  z.object({ kind: z.literal("missing_from_generation") }).strict(),
  /**
   * A person locked the page, so the run kept it as published. Older reviews
   * set it for a page that a person had edited, and started that page on the
   * published version.
   */
  z.object({ kind: z.literal("owned_by_person") }).strict(),
  /**
   * Older reviews only: a seeded run left out a hand-written page, and the
   * page started on the published version. New reviews start it removed,
   * like any removal.
   */
  z.object({ kind: z.literal("seed_page_kept") }).strict(),
  /** Statements of the hand-written page that the source contradicts. */
  z
    .object({
      kind: z.literal("seed_conflicts"),
      items: z.array(z.string().min(1).max(500)).max(20),
    })
    .strict(),
  /** The source files that the writer read for the page. */
  z
    .object({
      kind: z.literal("based_on_sources"),
      paths: z.array(z.string().min(1)).max(MAX_SOURCE_PATHS),
    })
    .strict(),
]);

const pageHrefSchema = z.string().startsWith("/").max(512);

/**
 * A page that a person locked: no generation changes it. Every page is
 * unlocked unless a person locks it, and every change still goes through a
 * review before it goes live.
 */
export const pageLockSchema = z.object({ href: pageHrefSchema }).strict();

export const pageLockListSchema = z
  .object({ pages: z.array(pageLockSchema) })
  .strict();

export const setPageLockInputSchema = z
  .object({ href: pageHrefSchema, locked: z.boolean() })
  .strict();

/**
 * A page that a person owns that the run did not update although it had a
 * reason to: its source files changed, the project instructions changed, or
 * the new plan has no page for it (`removed`). The person decides whether to
 * hand it back.
 */
const ownedPageFlagShape = {
  href: pageHrefSchema,
  title: z.string(),
  changedPaths: z.array(z.string().min(1)).max(20),
  instructionsChanged: z.literal(true).optional(),
  removed: z.literal(true).optional(),
};

export const ownedPageFlagSchema = z.object(ownedPageFlagShape).strict();

/**
 * Reads a flag that a review stored. A worker of a newer release can store
 * a field that this release does not know; the read drops it instead of
 * failing the whole review.
 */
export const storedOwnedPageFlagSchema = z.object(ownedPageFlagShape);

/** The bounds of the open issues that one page carries to the review. */
export const PAGE_OPEN_ISSUE_LIMITS = {
  issues: 10,
  checkLength: 64,
  messageLength: 240,
} as const;

/**
 * An issue that a written page still has: the writer kept the page after
 * its last attempt. Reads drop unknown keys, so a newer writer cannot break
 * an older reader.
 */
export const pageOpenIssueSchema = z.object({
  check: z.string().min(1).max(PAGE_OPEN_ISSUE_LIMITS.checkLength),
  message: z.string().min(1).max(PAGE_OPEN_ISSUE_LIMITS.messageLength),
  /** True when the issue breaks the owner's Doxabot instructions. */
  instructions: z.boolean(),
});

export const pageOpenIssuesSchema = z
  .array(pageOpenIssueSchema)
  .max(PAGE_OPEN_ISSUE_LIMITS.issues);

/** The job event that tells the review about a page the run wrote or kept. */
export const GENERATION_PAGE_NOTICE_EVENT_TYPE = "generation_page_notice";

/**
 * Why the review shows a notice for a page:
 * - `open_issues`: the run wrote the page, and it still has the issues listed.
 * - `behind_instructions`: runs stopped trying to bring the page up to the
 *   current instructions after `MAX_INSTRUCTION_CATCH_UP_ATTEMPTS` failures.
 */
export const pageNoticeKindSchema = z.enum(["open_issues", "behind_instructions"]);

/** Bounds a notice, so one long page title cannot bloat the run log or the review. */
export const PAGE_NOTICE_LIMITS = {
  pageIdLength: 512,
  titleLength: 200,
} as const;

/**
 * Text for a notice field: one line without control characters, cut to
 * `maxLength` with an ellipsis. The worker applies it when it builds a
 * notice, so a stored notice always passes {@link pageNoticeSchema}.
 */
export function boundedNoticeText(text: string, maxLength: number): string {
  const line = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return line.length <= maxLength ? line : `${line.slice(0, maxLength - 1).trimEnd()}…`;
}

export const pageNoticeSchema = z.object({
  pageId: z.string().min(1).max(PAGE_NOTICE_LIMITS.pageIdLength),
  title: z.string().min(1).max(PAGE_NOTICE_LIMITS.titleLength),
  href: pageHrefSchema.nullable(),
  kind: pageNoticeKindSchema,
  issues: pageOpenIssuesSchema,
});

/**
 * The job event that lists the outside domains that the run's written pages
 * link to and the repository does not contain. Outside links are allowed
 * (owner decision, 2026-10-27), so the event flags them and nothing removes them.
 */
export const UNVERIFIED_EXTERNAL_LINKS_EVENT_TYPE = "unverified_external_links";

export const UNVERIFIED_EXTERNAL_LINK_LIMITS = {
  domainLength: 253,
  domainsPerPage: 20,
  pages: 200,
  domains: 200,
} as const;

/** The unverified outside domains of one page. */
export const unverifiedExternalDomainsSchema = z
  .array(z.string().min(1).max(UNVERIFIED_EXTERNAL_LINK_LIMITS.domainLength))
  .max(UNVERIFIED_EXTERNAL_LINK_LIMITS.domainsPerPage);

export const unverifiedExternalLinkPageSchema = z.object({
  pageId: z.string().min(1).max(PAGE_NOTICE_LIMITS.pageIdLength),
  title: z.string().min(1).max(PAGE_NOTICE_LIMITS.titleLength),
  href: pageHrefSchema.nullable(),
  domains: unverifiedExternalDomainsSchema.min(1),
});

/** The data of an {@link UNVERIFIED_EXTERNAL_LINKS_EVENT_TYPE} event. */
export const unverifiedExternalLinksEventDataSchema = z.object({
  domains: z
    .array(z.string().min(1).max(UNVERIFIED_EXTERNAL_LINK_LIMITS.domainLength))
    .min(1)
    .max(UNVERIFIED_EXTERNAL_LINK_LIMITS.domains),
  pages: z.array(unverifiedExternalLinkPageSchema).min(1).max(UNVERIFIED_EXTERNAL_LINK_LIMITS.pages),
});

/** The job event that marks one page the run could not write. */
export const GENERATION_PAGE_FLAGGED_EVENT_TYPE = "generation_page_flagged";

/** What the finished version shows for a page that the run could not write. */
export const flaggedPageOutcomeSchema = z.enum(["kept_published", "left_out"]);

/**
 * A page that the run could not write after its retries. The run still
 * ended; the page kept its published version or is not in the version.
 */
export const flaggedPageSchema = z
  .object({
    pageId: z.string().min(1),
    title: z.string().min(1),
    reason: z.string().min(1).max(2_000),
    outcome: flaggedPageOutcomeSchema,
    /** The published page, for a page that kept its published version. */
    href: pageHrefSchema.nullable(),
  })
  .strict();

/** A page that a run changed: what the generation did to it, and why. */
export const generationChangedPageSchema = z
  .object({
    /** The href that the generation gave the page. */
    href: pageHrefSchema,
    title: z.string(),
    change: generationReviewPageChangeSchema,
    reasons: z.array(generationReviewReasonSchema),
  })
  .strict();

export const generationReviewPageSchema = generationChangedPageSchema
  .extend({
    /**
     * Where the page is on the review branch: `href`, unless a person
     * renamed or moved the page there.
     */
    branchHref: pageHrefSchema,
    decision: generationReviewPageDecisionSchema,
    decidedAt: z.iso.datetime().nullable(),
  })
  .strict();

/**
 * The pages that a pull request preview run changed, to read without
 * deciding. A merge starts a production run, which goes to a review.
 */
export const generationChangesSchema = z
  .object({
    jobId: z.uuid(),
    /**
     * The version that the pages compare with: the version the run was built
     * on, else the live version. Null when the site had no version.
     */
    baseVersionId: z.uuid().nullable(),
    /** The site that the run wrote. Null when the docs host is not configured. */
    previewUrl: z.url().nullable(),
    pages: z.array(generationChangedPageSchema),
  })
  .strict();

export const generationReviewSchema = z
  .object({
    id: z.uuid(),
    status: generationReviewStatusSchema,
    jobId: z.uuid(),
    branch: z
      .object({
        id: z.uuid(),
        name: branchNameSchema,
        baseVersionId: z.uuid(),
        revision: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    /** The generated site as the run wrote it, before any decision. Null when the docs host is not configured. */
    previewUrl: z.url().nullable(),
    /** True when publishing keeps the replaced site in a backup branch. */
    createsBackup: z.boolean(),
    backupBranchName: branchNameSchema.nullable(),
    pages: z.array(generationReviewPageSchema),
    ownedPageFlags: z.array(ownedPageFlagSchema),
    flaggedPages: z.array(flaggedPageSchema).default([]),
    /** Pages the run wrote or kept that a person should look at. */
    pageNotices: z.array(pageNoticeSchema).default([]),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const generationReviewResponseSchema = z
  .object({ review: generationReviewSchema.nullable() })
  .strict();

export const decideGenerationReviewPagesInputSchema = z
  .object({
    decisions: z
      .array(
        z
          .object({
            href: pageHrefSchema,
            decision: generationReviewDecisionInputSchema,
          })
          .strict(),
      )
      .min(1)
      .max(500),
    /**
     * True removes a page that a person edited on the review branch, edits
     * included. Without it, such a decision fails with `page_edited`, so
     * nobody loses edits without saying so.
     */
    discardEdits: z.boolean().optional(),
  })
  .strict();

export const generationReviewPageSourcesQuerySchema = z
  .object({ href: pageHrefSchema })
  .strict();

/** A page as the published site has it and as the generation wrote it. */
export const generationReviewPageSourcesSchema = z
  .object({
    href: pageHrefSchema,
    published: z.string().nullable(),
    generated: z.string().nullable(),
  })
  .strict();

export const publishGenerationReviewInputSchema = z
  .object({
    expectedBaseVersionId: z.uuid(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

export const publishGenerationReviewResultSchema = z
  .object({
    versionId: z.uuid(),
    backupBranchName: branchNameSchema.nullable(),
  })
  .strict();

export type GenerationReviewStatus = z.infer<
  typeof generationReviewStatusSchema
>;
export type GenerationReviewPageChange = z.infer<
  typeof generationReviewPageChangeSchema
>;
export type GenerationReviewPageDecision = z.infer<
  typeof generationReviewPageDecisionSchema
>;
export type GenerationReviewDecision = z.infer<
  typeof generationReviewDecisionSchema
>;
export type GenerationReviewDecisionInput = z.infer<
  typeof generationReviewDecisionInputSchema
>;
export type GenerationReviewReason = z.infer<
  typeof generationReviewReasonSchema
>;
export type GenerationReviewPage = z.infer<typeof generationReviewPageSchema>;
export type FlaggedPage = z.infer<typeof flaggedPageSchema>;
export type PageOpenIssue = z.infer<typeof pageOpenIssueSchema>;
export type PageNotice = z.infer<typeof pageNoticeSchema>;
export type UnverifiedExternalLinkPage = z.infer<typeof unverifiedExternalLinkPageSchema>;
export type UnverifiedExternalLinksEventData = z.infer<typeof unverifiedExternalLinksEventDataSchema>;
export type PageNoticeKind = z.infer<typeof pageNoticeKindSchema>;
export type FlaggedPageOutcome = z.infer<typeof flaggedPageOutcomeSchema>;
export type PageLock = z.infer<typeof pageLockSchema>;
export type PageLockList = z.infer<typeof pageLockListSchema>;
export type SetPageLockInput = z.infer<typeof setPageLockInputSchema>;
export type OwnedPageFlag = z.infer<typeof ownedPageFlagSchema>;
export type PageSources = z.infer<typeof pageSourcesSchema>;
export type GenerationReview = z.infer<typeof generationReviewSchema>;
export type GenerationReviewResponse = z.infer<
  typeof generationReviewResponseSchema
>;
export type DecideGenerationReviewPagesInput = z.infer<
  typeof decideGenerationReviewPagesInputSchema
>;
export type GenerationReviewPageSources = z.infer<
  typeof generationReviewPageSourcesSchema
>;
export type GenerationChangedPage = z.infer<typeof generationChangedPageSchema>;
export type GenerationChanges = z.infer<typeof generationChangesSchema>;
export type PublishGenerationReviewInput = z.infer<
  typeof publishGenerationReviewInputSchema
>;
export type PublishGenerationReviewResult = z.infer<
  typeof publishGenerationReviewResultSchema
>;
