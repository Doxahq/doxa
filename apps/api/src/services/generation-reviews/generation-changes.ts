import type {
  GenerationChanges,
  GenerationReviewPageSources,
} from "@doxahq/contracts/generation-reviews";
import { normalizeHref } from "@doxahq/docs-engine";
import type { Env } from "../../env";
import {
  GenerationChangesRepository,
  type ChangesVersion,
  type GenerationChangesSnapshot,
} from "../../repositories/generation-changes";
import { createGenerationPreviewUrl } from "../../utils/docs-url";
import { DocsContentError } from "../docs-content/errors";
import {
  createR2DocsContentStore,
  type DocsContentStore,
  withRequestReadCache,
} from "../docs-content/store";
import { compareReviewTrees } from "./review-pages";
import {
  EMPTY_REVIEW_PAGES,
  loadReviewTree,
  readPageSource,
  stripSeedConflicts,
  type ReviewPages,
} from "./review-tree";

interface ChangesScope {
  projectId: string;
  /** The project owner, whose project the run belongs to. */
  ownerUserId: string;
}

/** The two versions that the changes of a run compare. */
interface ChangesTrees {
  base: ReviewPages;
  generated: ReviewPages;
}

/**
 * The read-only changes of a pull request preview run: the pages that it
 * wrote, compared with the version that it was built on. Nobody decides on
 * them. A merge starts a production run, which goes to a review.
 */
export class GenerationChangesService {
  constructor(
    private readonly deps: {
      changes: Pick<GenerationChangesRepository, "snapshot">;
      store: Pick<DocsContentStore, "read" | "listKeys">;
      previewUrl: (version: { projectSlug: string; docsVersionId: string }) => string | null;
    },
  ) {}

  static fromEnv(env: Env): GenerationChangesService {
    return new GenerationChangesService({
      changes: new GenerationChangesRepository(env),
      store: withRequestReadCache(createR2DocsContentStore(env.DOCS_BUCKET)),
      previewUrl: (version) => createGenerationPreviewUrl(version, env),
    });
  }

  async list(scope: ChangesScope, jobId: string): Promise<GenerationChanges> {
    const snapshot = await this.requireSnapshot(scope, jobId);
    const generated = requireGenerated(snapshot);
    const trees = await this.trees(snapshot.base, generated);

    return {
      jobId: snapshot.jobId,
      baseVersionId: snapshot.base?.versionId ?? null,
      previewUrl: snapshot.siteSlug
        ? this.deps.previewUrl({ projectSlug: snapshot.siteSlug, docsVersionId: generated.versionId })
        : null,
      pages: await compareReviewTrees(trees.base, trees.generated),
    };
  }

  /** One page as the base version has it and as the run wrote it. */
  async pageSources(
    scope: ChangesScope,
    jobId: string,
    href: string,
  ): Promise<GenerationReviewPageSources> {
    const snapshot = await this.requireSnapshot(scope, jobId);
    const trees = await this.trees(snapshot.base, requireGenerated(snapshot));
    const normalizedHref = normalizeHref(href);
    const [published, generated] = await Promise.all([
      readPageSource(trees.base, normalizedHref),
      readPageSource(trees.generated, normalizedHref),
    ]);
    if (published === null && generated === null) {
      throw new DocsContentError("not_found", `The run changed no page at ${href}.`);
    }

    return { href: normalizedHref, published, generated: stripSeedConflicts(generated) };
  }

  private async requireSnapshot(
    scope: ChangesScope,
    jobId: string,
  ): Promise<GenerationChangesSnapshot> {
    const snapshot = await this.deps.changes.snapshot({ ...scope, jobId });
    if (!snapshot) throw new DocsContentError("not_found", "Generation not found.");
    if (snapshot.publicationMode !== "preview") {
      throw new DocsContentError(
        "invalid",
        "Only a pull request preview shows its changes here. A production run opens a review.",
      );
    }

    return snapshot;
  }

  private async trees(base: ChangesVersion | null, generated: ChangesVersion): Promise<ChangesTrees> {
    const [baseTree, generatedTree] = await Promise.all([
      base ? loadReviewTree(this.deps.store, base.artifactPrefix) : EMPTY_REVIEW_PAGES,
      loadReviewTree(this.deps.store, generated.artifactPrefix),
    ]);
    return { base: baseTree, generated: generatedTree };
  }
}

function requireGenerated(snapshot: GenerationChangesSnapshot): ChangesVersion {
  if (snapshot.status !== "succeeded" || !snapshot.generated) {
    throw new DocsContentError("not_found", "This run wrote no documentation version.");
  }
  if (snapshot.generated.isCollected) {
    throw new DocsContentError(
      "not_found",
      "The files of this run were deleted after the retention period.",
    );
  }

  return snapshot.generated;
}
