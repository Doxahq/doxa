import { classifyBranchPath } from "@doxahq/contracts/docs-branches";
import {
  storedOwnedPageFlagSchema,
  type DecideGenerationReviewPagesInput,
  type FlaggedPage,
  type PageNotice,
  type GenerationReview,
  type GenerationReviewDecisionInput,
  type GenerationReviewPageSources,
  type OwnedPageFlag,
  type PageLock,
  type PageSources,
  type PublishGenerationReviewInput,
  type PublishGenerationReviewResult,
} from "@doxahq/contracts/generation-reviews";
import { z } from "zod";
import {
  buildArtifactPrefix,
  normalizeHref,
  sourcePathForHref,
} from "@doxahq/docs-engine";
import type { WarmPool } from "@doxahq/contracts/docs-warm-state";
import type { Env } from "../../env";
import type { StoredBranchChange } from "../../repositories/docs-branch-records";
import { toReviewPageDto } from "../../repositories/generation-review-records";
import {
  GenerationReviewsRepository,
  type OpenReviewSnapshot,
  type ReviewSiteSnapshot,
} from "../../repositories/generation-reviews";
import { DocsBranchPublish } from "../docs-branches/publish";
import {
  prepareWorkingChanges,
  type DesiredChange,
} from "../docs-branches/working-changes";
import { DocsContentError } from "../docs-content/errors";
import type { ContentStructure } from "../docs-content/structure";
import {
  createR2DocsContentStore,
  type DocsContentStore,
  withRequestReadCache,
} from "../docs-content/store";
import {
  createCollectStorageNow,
  type CollectStorageNow,
} from "../storage-gc/collect-now";
import { desiredReviewChanges, reviewStructure } from "./review-changes";
import {
  applyDecisionsToBranch,
  type DecidedReviewPage,
} from "./review-decisions";
import { hasPage, placeMovedPages, type ReviewPageMove } from "./review-moves";
import { compareReviewTrees, INITIAL_DECISION, planRunPages } from "./review-pages";
import type { StoredReviewDecision } from "../../repositories/generation-reviews";
import { createGenerationPreviewUrl } from "../../utils/docs-url";
import {
  loadReviewTree,
  readPageSource,
  stripSeedConflicts,
  type ReviewTree,
} from "./review-tree";
import { JobsRepository } from "../../repositories/jobs";

const MAX_SAVE_ATTEMPTS = 3;

/** What the worker reports about a run besides its pages. */
export interface RunEvidence {
  ownedPageFlags?: readonly OwnedPageFlag[];
  pageSources?: readonly PageSources[];
}

export type OpenRunReviewOutcome =
  | "opened"
  | "unchanged"
  | "already_open"
  | "not_staged";

type ReviewRepository = Pick<
  GenerationReviewsRepository,
  | "snapshotForProject"
  | "snapshotForJob"
  | "existsForJob"
  | "recordUnchangedRun"
  | "saveRunReview"
  | "decide"
  | "discard"
>;

interface ProjectScope {
  projectId: string;
  /** The project owner, who owns the review branch. */
  ownerUserId: string;
}

interface ActorScope extends ProjectScope {
  /** The member who acts, recorded on decisions and closes. */
  actorUserId: string;
}

/**
 * Turns a finished production generation into a review branch, applies the
 * decisions a person makes on it, and publishes or discards it.
 */
export class GenerationReviewService {
  constructor(
    private readonly deps: {
      reviews: ReviewRepository;
      store: Pick<DocsContentStore, "read" | "listKeys">;
      publisher: Pick<DocsBranchPublish, "publishBranch">;
      collectStorage: CollectStorageNow;
      previewUrl: (version: { projectSlug: string; docsVersionId: string }) => string | null;
      /** The pages that a run could not write, which the review flags. */
      flaggedPages: (jobId: string) => Promise<FlaggedPage[]>;
      /** The pages the run wrote or kept that a person should look at. */
      pageNotices: (jobId: string) => Promise<PageNotice[]>;
    },
  ) {}

  static fromEnv(env: Env): GenerationReviewService {
    return new GenerationReviewService({
      reviews: new GenerationReviewsRepository(env),
      store: withRequestReadCache(createR2DocsContentStore(env.DOCS_BUCKET)),
      publisher: DocsBranchPublish.fromEnv(env),
      collectStorage: createCollectStorageNow(env),
      previewUrl: (version) => createGenerationPreviewUrl(version, env),
      flaggedPages: (jobId) => new JobsRepository(env).listFlaggedPages(jobId),
      pageNotices: (jobId) => new JobsRepository(env).listPageNotices(jobId),
    });
  }

  /**
   * Builds the review of a run whose version is staged. A repeated call for
   * the same run is safe: it finds the review and changes nothing.
   */
  async openForRun(
    jobId: string,
    evidence: RunEvidence = {},
  ): Promise<OpenRunReviewOutcome> {
    const ownedPageFlags = evidence.ownedPageFlags ?? [];
    const sourcesByHref = new Map(
      (evidence.pageSources ?? []).map((page) => [page.href, page.paths]),
    );
    for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt += 1) {
      const snapshot = await this.deps.reviews.snapshotForJob(jobId);
      if (!snapshot?.main) {
        return "not_staged";
      }

      if (await this.deps.reviews.existsForJob(jobId)) {
        return "already_open";
      }

      const open = snapshot.openReview;
      const [main, generated, branch] = await Promise.all([
        loadReviewTree(this.deps.store, snapshot.main.artifactPrefix),
        loadReviewTree(this.deps.store, snapshot.generated.artifactPrefix),
        open?.branch
          ? loadReviewTree(
              this.deps.store,
              buildArtifactPrefix(snapshot.siteId, open.branch.baseVersionId),
              open.branch.changes,
            )
          : null,
      ]);
      const planned = planRunPages(
        await compareReviewTrees(main, generated),
        open?.pages ?? [],
        {
          lockedHrefs: new Set(snapshot.locks.map((lock: PageLock) => lock.href)),
          sourcesByHref,
        },
      );

      if (planned.length === 0 && ownedPageFlags.length === 0 && !open) {
        await this.deps.reviews.recordUnchangedRun(jobId);
        return "unchanged";
      }

      const placement = placeMovedPages({
        structure: reviewStructure(main, generated, planned),
        branch,
        pages: planned,
        prior: open?.pages ?? [],
      });
      const pages = placement.pages;
      const existing = open?.branch?.changes ?? [];
      const desired = await desiredReviewChanges({
        main,
        generated,
        pages,
        structure: placement.structure,
      });
      resetObsoleteRunChanges(desired, existing);
      keepPersonEdits(
        desired,
        existing,
        releaseMoves(desired, placement.structure, placement.released),
      );
      const saved = await this.deps.reviews.saveRunReview({
        siteId: snapshot.siteId,
        ownerUserId: snapshot.ownerUserId,
        jobId,
        generatedVersionId: snapshot.generated.versionId,
        createsBackup: snapshot.replacesEditorContent,
        ownedPageFlags,
        expected: {
          mainVersionId: snapshot.main.versionId,
          openReview: open
            ? { id: open.review.id, branchRevision: open.branch?.revision ?? null }
            : null,
        },
        pages,
        writes: await prepareWorkingChanges({
          store: this.deps.store,
          basePrefix: snapshot.main.artifactPrefix,
          existing,
          desired,
        }),
      });

      if (saved.status === "saved") {
        return "opened";
      }

      if (saved.status !== "stale") {
        throw branchLimitError(saved.status);
      }
    }

    throw new DocsContentError(
      "conflict",
      "The site changed while the review was being prepared. Try again.",
    );
  }

  async get(scope: ProjectScope): Promise<GenerationReview | null> {
    const snapshot = await this.deps.reviews.snapshotForProject(scope);
    const open = snapshot?.openReview;
    if (!open) return null;
    return toReviewDto(
      open,
      this.deps.previewUrl({
        projectSlug: snapshot.siteSlug,
        docsVersionId: open.review.generatedVersionId,
      }),
      await this.deps.flaggedPages(open.review.jobId),
      await this.deps.pageNotices(open.review.jobId),
    );
  }

  /** One page of the review: published against generated, whatever the decision. */
  async pageSources(
    scope: ProjectScope,
    href: string,
  ): Promise<GenerationReviewPageSources> {
    const { snapshot, open, branch } = await this.requireOpenReview(scope);
    const normalizedHref = normalizeHref(href);
    if (!open.pages.some((page) => page.href === normalizedHref)) {
      throw new DocsContentError("not_found", `The review has no page at ${href}.`);
    }

    const [base, generated] = await Promise.all([
      loadReviewTree(
        this.deps.store,
        buildArtifactPrefix(snapshot.siteId, branch.baseVersionId),
      ),
      this.generatedTree(snapshot.siteId, open),
    ]);
    return {
      href: normalizedHref,
      published: await readPageSource(base, normalizedHref),
      generated: stripSeedConflicts(
        await readPageSource(generated, normalizedHref),
      ),
    };
  }

  async decide(
    scope: ActorScope,
    input: DecideGenerationReviewPagesInput,
  ): Promise<GenerationReview> {
    const { snapshot, open, branch } = await this.requireOpenReview(scope);
    const decisions = resolveDecisions(
      open,
      new Map<string, GenerationReviewDecisionInput>(
        input.decisions.map((entry) => [normalizeHref(entry.href), entry.decision]),
      ),
    );
    const basePrefix = buildArtifactPrefix(snapshot.siteId, branch.baseVersionId);
    const [base, generated, current] = await Promise.all([
      loadReviewTree(this.deps.store, basePrefix),
      this.generatedTree(snapshot.siteId, open),
      loadReviewTree(this.deps.store, basePrefix, branch.changes),
    ]);
    const personEdits = new Set(
      branch.changes.filter(isPersonEdit).map((change) => change.path),
    );
    const applied = await applyDecisionsToBranch({
      branch: current,
      main: base,
      generated,
      pages: decidedPages(open, decisions),
      isPersonEdit: (path) => personEdits.has(path),
    });
    if (applied.droppedEdits.length > 0 && input.discardEdits !== true) {
      throw new DocsContentError(
        "page_edited",
        "You edited this page on the review branch. Confirm to remove it with your edits.",
        { hrefs: applied.droppedEdits },
      );
    }
    const decided = await this.deps.reviews.decide({
      siteId: snapshot.siteId,
      reviewId: open.review.id,
      actorUserId: scope.actorUserId,
      ownerUserId: scope.ownerUserId,
      expectedRevision: branch.revision,
      decisions,
      branchHrefs: applied.branchHrefs,
      writes: await prepareWorkingChanges({
        store: this.deps.store,
        basePrefix,
        existing: branch.changes,
        desired: applied.desired,
      }),
    });

    if (decided.status === "stale") {
      throw new DocsContentError(
        "conflict",
        "The review changed after you opened it. Reload it and try again.",
      );
    }

    if (decided.status === "not_found") {
      throw noOpenReview();
    }

    if (decided.status !== "decided") {
      throw branchLimitError(decided.status);
    }

    return this.requireReviewDto(scope);
  }

  async publish(
    scope: ActorScope,
    input: PublishGenerationReviewInput,
    options: { warmRegion?: WarmPool | null } = {},
  ): Promise<PublishGenerationReviewResult> {
    const { branch } = await this.requireOpenReview(scope);
    const published = await this.deps.publisher.publishBranch({
      userId: scope.ownerUserId,
      projectId: scope.projectId,
      branch: branch.id,
      request: { ...input, eraseBranch: true },
      ...(options.warmRegion ? { warmRegion: options.warmRegion } : {}),
    });

    return {
      versionId: published.result.versionId,
      backupBranchName: published.review?.backupBranchName ?? null,
    };
  }

  async discard(scope: ActorScope): Promise<void> {
    const { snapshot, open } = await this.requireOpenReview(scope);
    const collectEntryIds = await this.deps.reviews.discard({
      siteId: snapshot.siteId,
      reviewId: open.review.id,
      actorUserId: scope.actorUserId,
    });

    if (collectEntryIds === null) {
      throw noOpenReview();
    }

    await this.deps.collectStorage(collectEntryIds);
  }

  private async requireOpenReview(scope: ProjectScope): Promise<{
    snapshot: ReviewSiteSnapshot;
    open: OpenReviewSnapshot;
    branch: NonNullable<OpenReviewSnapshot["branch"]>;
  }> {
    const snapshot = await this.deps.reviews.snapshotForProject(scope);
    const open = snapshot?.openReview;
    if (!snapshot || !open?.branch) {
      throw noOpenReview();
    }

    return { snapshot, open, branch: open.branch };
  }

  private async requireReviewDto(scope: ProjectScope): Promise<GenerationReview> {
    const review = await this.get(scope);
    if (!review) {
      throw noOpenReview();
    }

    return review;
  }

  private generatedTree(
    siteId: string,
    open: OpenReviewSnapshot,
  ): Promise<ReviewTree> {
    return loadReviewTree(
      this.deps.store,
      buildArtifactPrefix(siteId, open.review.generatedVersionId),
    );
  }
}

/**
 * Leaves the page bodies and site settings that a person edited on the
 * review branch alone, except at `overrides`. Structure files always follow
 * the decisions.
 */
function keepPersonEdits(
  desired: Map<string, DesiredChange>,
  existing: readonly StoredBranchChange[],
  overrides: ReadonlySet<string> = new Set(),
): void {
  for (const change of existing) {
    if (isPersonEdit(change) && !overrides.has(change.path)) {
      desired.delete(change.path);
    }
  }
}

/**
 * Puts the pages of the moves that a run released back at their own href:
 * the body there replaces the delete that the move left, and the copy that
 * the person moved goes where no page uses its href anymore. Returns the
 * paths where these writes win over the person's edits.
 */
function releaseMoves(
  desired: Map<string, DesiredChange>,
  structure: ContentStructure,
  released: readonly ReviewPageMove[],
): Set<string> {
  const overrides = new Set<string>();
  for (const move of released) {
    const home = sourcePathForHref(move.href);
    const moved = sourcePathForHref(move.branchHref);
    if (hasPage(structure, move.href) && !desired.has(home)) {
      desired.set(home, undefined);
    }
    if (!hasPage(structure, move.branchHref)) {
      desired.set(moved, undefined);
    }
    overrides.add(home);
    overrides.add(moved);
  }

  return overrides;
}

/**
 * Resets the agent changes of an earlier run that the newer run no longer
 * makes, for example a page that the newer run leaves as published.
 */
function resetObsoleteRunChanges(
  desired: Map<string, DesiredChange>,
  existing: readonly StoredBranchChange[],
): void {
  for (const change of existing) {
    const obsolete =
      !isPersonEdit(change) &&
      !desired.has(change.path) &&
      classifyBranchPath(change.path) !== "asset";

    if (obsolete) {
      desired.set(change.path, undefined);
    }
  }
}

function isPersonEdit(change: StoredBranchChange): boolean {
  const kind = classifyBranchPath(change.path);
  return (
    change.origin === "editor" && (kind === "page" || kind === "site_settings")
  );
}

/**
 * The decision that each input stores. A taken-back decision returns the
 * page to the generation's change, and to no person.
 */
function resolveDecisions(
  open: OpenReviewSnapshot,
  inputs: ReadonlyMap<string, GenerationReviewDecisionInput>,
): Map<string, StoredReviewDecision> {
  const decisions = new Map<string, StoredReviewDecision>();
  for (const [href, input] of inputs) {
    requireReviewPage(open, href);
    decisions.set(
      href,
      input === "undecided"
        ? { decision: INITIAL_DECISION, byPerson: false }
        : { decision: input, byPerson: true },
    );
  }

  return decisions;
}

/** The decided pages of the review, with their new decisions. */
function decidedPages(
  open: OpenReviewSnapshot,
  decisions: ReadonlyMap<string, StoredReviewDecision>,
): DecidedReviewPage[] {
  return [...decisions].map(([href, { decision }]) => {
    const page = requireReviewPage(open, href);
    return {
      href: page.href,
      branchHref: page.branchHref,
      change: page.change,
      decision,
      previousDecision: page.decision,
    };
  });
}

function requireReviewPage(open: OpenReviewSnapshot, href: string) {
  const page = open.pages.find((entry) => entry.href === href);
  if (!page) {
    throw new DocsContentError("invalid", `The review has no page at ${href}.`);
  }

  return page;
}

function toReviewDto(
  open: OpenReviewSnapshot,
  previewUrl: string | null,
  flaggedPages: FlaggedPage[],
  pageNotices: PageNotice[],
): GenerationReview {
  return {
    id: open.review.id,
    status: open.review.status,
    jobId: open.review.jobId,
    previewUrl,
    branch: open.branch
      ? {
          id: open.branch.id,
          name: open.branch.name,
          baseVersionId: open.branch.baseVersionId,
          revision: open.branch.revision,
        }
      : null,
    createsBackup: open.review.createsBackup,
    backupBranchName: null,
    pages: open.pages.map(toReviewPageDto),
    ownedPageFlags: ownedPageFlagListSchema.parse(open.review.ownedPageFlags),
    flaggedPages,
    pageNotices,
    createdAt: open.review.createdAt.toISOString(),
    updatedAt: open.review.updatedAt.toISOString(),
  };
}

const ownedPageFlagListSchema = z.array(storedOwnedPageFlagSchema);


function noOpenReview(): DocsContentError {
  return new DocsContentError("not_found", "There is no open generation review.");
}

function branchLimitError(
  status: "too_many_changes" | "branch_too_large",
): DocsContentError {
  return new DocsContentError(
    "invalid",
    status === "too_many_changes"
      ? "The generation changes more files than one review can hold."
      : "The generated content is larger than one review can hold.",
  );
}
