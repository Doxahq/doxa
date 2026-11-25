import type {
  DocsPublishStage,
  PublishDocsBranchInput,
  PublishDocsBranchResult,
} from "@doxahq/contracts/docs-branches";
import type { WarmPool } from "@doxahq/contracts/docs-warm-state";
import type { Env } from "../../env";
import type {
  DocsBranchStore,
  StoredBranchChange,
} from "../../repositories/docs-branches";
import { DocsBranchesRepository } from "../../repositories/docs-branches";
import {
  branchChangedSinceReview,
  DocsBranchPublicationRepository,
  type StoredBranchPublication,
} from "../../repositories/docs-branch-publication";
import { DocsVersionGcEntriesRepository } from "../../repositories/docs-version-gc-entries";
import type { PublicationAttribution } from "../../repositories/docs-publications";
import { buildDocsWarmHint } from "../docs-warm-hint";
import { planSeamsFromEnv } from "../billing/plan-seams";
import {
  createR2SiteAssetStore,
  type SiteAssetStore,
} from "../site-assets/store";
import {
  createR2DocsContentStore,
  type DocsContentStore,
  withRequestReadCache,
} from "../docs-content/store";
import { DocsContentError } from "../docs-content/errors";
import {
  branchMdxIssues,
  describeBlockedPublish,
} from "../docs-content/page-mdx-issues";
import type { EntitlementsService } from "../entitlements";
import {
  createCollectStorageNow,
  type CollectStorageNow,
} from "../storage-gc/collect-now";
import { BranchResolver } from "./branch-resolver";
import { materializeBranchArtifacts } from "./materialize-branch";
import { publishedPageChanges } from "./page-moves";
import { publishViaOf, reportDocsPublishedInBackground, type DocsPublishedFacts } from "./publish-analytics";

export interface BranchPublishRequest {
  userId: string;
  projectId: string;
  branch: string;
  request: PublishDocsBranchInput;
  /** Receives each stage when the publish reaches it. */
  onStage?: (stage: DocsPublishStage) => void;
  /** Set when an agent action publishes. */
  attribution?: PublicationAttribution;
  /**
   * The publisher's cache pool, when a person publishes from a request
   * (M45). The regional warm job starts there.
   */
  warmRegion?: WarmPool | null;
}

export class DocsBranchPublish {
  private readonly resolver: BranchResolver;

  constructor(
    private readonly deps: {
      branches: Pick<DocsBranchStore, "resolveForUser" | "listChanges">;
      store: DocsContentStore;
      entitlements: EntitlementsService;
      assets: Pick<SiteAssetStore, "head">;
      publish: DocsBranchPublicationRepository["publish"];
      collectStorage: CollectStorageNow;
      enqueueOrphanVersion(input: {
        siteId: string;
        versionId: string;
      }): Promise<unknown>;
      /** Product analytics of a publish that went live. Absent: nothing is reported. */
      reportPublished?: (facts: DocsPublishedFacts) => void;
    },
  ) {
    this.resolver = new BranchResolver(deps.branches);
  }

  static fromEnv(env: Env): DocsBranchPublish {
    const repository = new DocsBranchPublicationRepository(env);
    const gcEntries = new DocsVersionGcEntriesRepository(env);
    return new DocsBranchPublish({
      branches: new DocsBranchesRepository(env),
      store: withRequestReadCache(
        createR2DocsContentStore(env.DOCS_BUCKET),
      ),
      entitlements: planSeamsFromEnv(env).entitlements,
      assets: createR2SiteAssetStore(env.DOCS_BUCKET),
      publish: (input) => repository.publish(input),
      collectStorage: createCollectStorageNow(env),
      enqueueOrphanVersion: (input) =>
        gcEntries.enqueueOrphanVersionPrefix(input),
      reportPublished: (facts) => reportDocsPublishedInBackground(env, facts),
    });
  }

  async publish(input: BranchPublishRequest): Promise<PublishDocsBranchResult> {
    return (await this.publishBranch(input)).result;
  }

  /** Publishes and also reports the generation review that it closed. */
  async publishBranch(
    input: BranchPublishRequest,
  ): Promise<Omit<StoredBranchPublication, "collectEntryIds">> {
    input.onStage?.("preparing");
    const context = await this.resolver.resolve({
      userId: input.userId,
      projectId: input.projectId,
      branchRef: input.branch,
    });

    if (!context.branch) {
      throw new DocsContentError(
        "no_changes",
        "This branch has no changes to publish.",
      );
    }

    const changes = await this.deps.branches.listChanges(input);

    if (!changes.length) {
      throw new DocsContentError(
        "no_changes",
        "This branch has no changes to publish.",
      );
    }

    if (
      context.branch.baseVersionId !== input.request.expectedBaseVersionId ||
      context.main.versionId !== input.request.expectedBaseVersionId
    ) {
      throw new DocsContentError(
        "branch_behind",
        "Main changed. Synchronize this branch first.",
      );
    }

    if (context.branch.revision !== input.request.expectedRevision) {
      throw branchChangedSinceReview();
    }

    assertPublishableMdx(changes);

    const versionId = crypto.randomUUID();
    await this.deps.enqueueOrphanVersion({
      siteId: context.main.siteId,
      versionId,
    });
    input.onStage?.("building");
    const materialized = await materializeBranchArtifacts(this.deps, {
      projectId: context.main.projectId,
      projectName: context.main.projectName,
      siteId: context.main.siteId,
      branch: context.branch,
      baseArtifactPrefix: context.basePrefix,
      changes,
      targetVersionId: versionId,
      generatedAt: new Date().toISOString(),
    });

    // Locks follow the pages that this publication moves or removes.
    const pageChanges = await publishedPageChanges(this.deps.store, {
      baseArtifactPrefix: context.basePrefix,
      changes,
    });

    // Ordering only: the publisher's pool and the changed pages go first.
    const warm = buildDocsWarmHint({ region: input.warmRegion, changes });

    input.onStage?.("optimizing");
    const published = await this.deps.publish({
      userId: input.userId,
      projectId: input.projectId,
      branch: input.branch,
      expectedBaseVersionId: input.request.expectedBaseVersionId,
      expectedRevision: input.request.expectedRevision,
      eraseBranch: input.request.eraseBranch,
      versionId,
      artifactPrefix: materialized.artifactPrefix,
      manifestPath: materialized.manifestPath,
      summary: materialized.summary,
      attribution: input.attribution,
      pageMoves: pageChanges.moves,
      removedHrefs: pageChanges.removedHrefs,
      ...(warm ? { warm } : {}),
    });
    await this.deps.collectStorage(published.collectEntryIds);
    this.deps.reportPublished?.({
      userId: input.userId,
      projectId: input.projectId,
      siteId: context.main.siteId,
      via: publishViaOf({ attribution: input.attribution, review: published.review }),
    });

    return { result: published.result, review: published.review };
  }
}

/**
 * Spec 8.1: a page that fails the MDX check never goes live. Every publish
 * path runs this, the dashboard route and an agent's approved request alike.
 */
export function assertPublishableMdx(
  changes: readonly StoredBranchChange[],
): void {
  const pages = branchMdxIssues(changes);
  if (pages.length === 0) return;
  throw new DocsContentError("mdx_invalid", describeBlockedPublish(pages), {
    pages,
  });
}
