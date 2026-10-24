import {
  type DocsContentEdit,
  type DocsContentEditOrigin,
  type DocsContentMdxReport,
  type DocsContentOverviewDto,
  type DocsContentPageDetailDto,
  type DocsContentPageDto,
  type DocsContentWorkingDto,
} from "@doxahq/contracts";
import {
  normalizeHref,
  sourcePathForHref,
  type DocsManifest,
} from "@doxahq/docs-engine";
import { validateSiteConfig } from "../site-config-validation";
import { createValidationIssue } from "@doxahq/site-config";
import { SiteConfigValidationError } from "../site-config-validation";
import type { Env } from "../../env";
import type {
  DocsBranchStore,
  StoredBranchChange,
} from "../../repositories/docs-branches";
import type { EntitlementsService } from "../entitlements";
import type { SiteAssetStore } from "../site-assets/store";
import {
  BranchResolver,
  type ResolvedBranchContext,
} from "../docs-branches/branch-resolver";
import { EffectiveTree } from "../docs-branches/effective-tree";
import { buildEditWrites } from "../docs-branches/editor";
import { createDocsContentDependencies } from "./dependencies";
import {
  DocsContentError,
  getDocsContentErrorStatus,
  type DocsContentErrorCode,
} from "./errors";
import { buildPublishedNavigation } from "./navigation";
import { branchMdxIssues } from "./page-mdx-issues";
import { readPublishedSiteConfig } from "./site-config";
import { withRequestReadCache, type DocsContentStore } from "./store";
import { unmeasured, type MeasureStep } from "../request-timing";

export {
  DocsContentError,
  getDocsContentErrorStatus,
  type DocsContentErrorCode,
};

export interface DocsContentActor {
  userId: string;
  origin: DocsContentEditOrigin;
}

export interface ApplyEditsOptions {
  /**
   * The branch revision the caller last read. When set and the branch is at
   * another revision, the edit fails with `conflict` and is not retried. Main
   * without a hidden branch is at revision 0, as `working.revision` reports.
   */
  expectedRevision?: number;
  /** Validates the edits and computes their writes, then writes nothing. */
  dryRun?: boolean;
}

export interface DocsContentReadOptions {
  /**
   * Reads main's live version and ignores the user's unpublished main drafts.
   * Only valid with the branch ref "main".
   */
  published?: boolean;
}

interface DocsContentView {
  context: ResolvedBranchContext;
  changes: readonly StoredBranchChange[];
  tree: EffectiveTree;
}

export interface DocsContentServiceDeps {
  store: DocsContentStore;
  branches: DocsBranchStore;
  entitlements: EntitlementsService;
  assets: Pick<SiteAssetStore, "head">;
  /** Measures database and storage steps for Server-Timing. */
  measure?: MeasureStep;
}

export interface DocsContentRequestOptions {
  measure?: MeasureStep;
  /** Keeps cache fills alive after the response. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export class DocsContentService {
  private readonly resolver: BranchResolver;
  private readonly measure: MeasureStep;

  constructor(private readonly deps: DocsContentServiceDeps) {
    this.resolver = new BranchResolver(deps.branches);
    this.measure = deps.measure ?? unmeasured;
  }

  /**
   * One service for one request. The store answers repeated reads of a key
   * from memory, so a request reads each artifact, such as the manifest,
   * once.
   */
  static fromEnv(
    env: Env,
    options: DocsContentRequestOptions = {},
  ): DocsContentService {
    const deps = createDocsContentDependencies(env, options);
    return new DocsContentService({
      ...deps,
      store: withRequestReadCache(deps.store),
      measure: options.measure,
    });
  }

  async getOverview(
    actor: DocsContentActor,
    projectId: string,
    branchRef = "main",
    options: DocsContentReadOptions = {},
  ): Promise<DocsContentOverviewDto> {
    const { context, changes, tree } = await this.openView(
      actor,
      projectId,
      branchRef,
      options,
    );
    // The published site settings need only main's manifest, so they load
    // with the effective content instead of after it.
    const publishedConfigRead = this.readBaseManifest(context).then(
      (baseManifest) =>
        this.measure("r2.config", () =>
          readPublishedSiteConfig(this.deps.store, context.main, baseManifest),
        ),
    );
    // Awaited below, after the content, so a content error still wins.
    publishedConfigRead.catch(() => undefined);
    const effective = await tree.content();
    const hrefs = new Set(
      effective.manifest.pages.map((page) => normalizeHref(page.href)),
    );
    const navigation = buildPublishedNavigation(effective.navigation, hrefs);
    const editedPaths = new Set(
      changes
        .filter((change) => change.kind === "upsert")
        .map((change) => change.path),
    );
    const pages: DocsContentPageDto[] = effective.manifest.pages.map(
      (page) => ({
        href: normalizeHref(page.href),
        title: page.title,
        sourcePath: page.sourcePath || sourcePathForHref(page.href),
        status: editedPaths.has(sourcePathForHref(page.href))
          ? "edited"
          : "published",
        icon:
          navigation.placementsByHref.get(normalizeHref(page.href))?.icon ??
          null,
      }),
    );
    const configChange = changes.find(
      (change) => change.path === "settings/site.json",
    );
    const workingConfig =
      configChange?.kind === "upsert"
        ? parseWorkingConfig(configChange.content)
        : null;
    const publishedConfig = await publishedConfigRead;
    return {
      projectId: context.main.projectId,
      projectSlug: context.main.projectSlug,
      siteId: context.main.siteId,
      publishedVersion: {
        id: context.main.versionId,
        versionNumber: context.main.versionNumber,
        createdAt: context.main.createdAt.toISOString(),
      },
      working: toWorkingDto(context, changes),
      entitlements:
        await this.deps.entitlements.getProjectEntitlements(projectId),
      siteConfig: {
        published: publishedConfig,
        working: workingConfig,
      },
      pages,
      navigation: navigation.sections,
    };
  }

  async getPage(
    actor: DocsContentActor,
    projectId: string,
    href: string,
    branchRef = "main",
    options: DocsContentReadOptions = {},
  ): Promise<DocsContentPageDetailDto> {
    const { context, changes, tree } = await this.openView(
      actor,
      projectId,
      branchRef,
      options,
    );
    // The page path comes from the href, so the page source is read with
    // the manifest. The manifest still decides: an href that it does not
    // list is "not found", whatever the speculative read found.
    const requestedPath = sourcePathForHref(href);
    const speculativeRead = Promise.resolve()
      .then(() =>
        this.measure("r2.page", () =>
          this.deps.store.read(`${context.basePrefix}/${requestedPath}`),
        ),
      )
      .then(
        (content) => ({ ok: true as const, content }),
        () => ({ ok: false as const }),
      );
    const manifest = await tree.manifest();
    const page = findManifestPage(manifest, href);
    const path = sourcePathForHref(page.href);
    const change = changes.find((item) => item.path === path);
    const speculative = await speculativeRead;
    // A failed read, or another path, reads again so a real error surfaces.
    const publishedContent =
      speculative.ok && path === requestedPath
        ? speculative.content
        : await this.measure("r2.page", () =>
            this.deps.store.read(`${context.basePrefix}/${path}`),
          );
    return {
      href: normalizeHref(page.href),
      title: page.title,
      sourcePath: path,
      status: change?.kind === "upsert" ? "edited" : "published",
      publishedContent: publishedContent ?? "",
      workingContent: change?.kind === "upsert" ? change.content : null,
    };
  }

  /**
   * The changed pages of the branch that fail the MDX check (spec 8.1).
   * Computed on demand from the branch changes, the same way a publish
   * checks them, so the two never disagree.
   */
  async getMdxReport(
    actor: DocsContentActor,
    projectId: string,
    branchRef = "main",
  ): Promise<DocsContentMdxReport> {
    const { changes } = await this.resolveWithChanges(
      actor,
      projectId,
      branchRef,
    );
    return { pages: branchMdxIssues(changes) };
  }

  async applyEdits(
    actor: DocsContentActor,
    projectId: string,
    edits: readonly DocsContentEdit[],
    branchRef = "main",
    options: ApplyEditsOptions = {},
  ): Promise<DocsContentWorkingDto> {
    const { expectedRevision, dryRun = false } = options;

    for (let attempt = 0; attempt < 5; attempt++) {
      const context = await this.resolver.resolve({
        userId: actor.userId,
        projectId,
        branchRef,
      });
      assertExpectedRevision(context, expectedRevision);
      const changes = await this.listChanges(actor, projectId, branchRef);
      const tree = new EffectiveTree(
        this.deps.store,
        context.basePrefix,
        changes,
      );
      const { writes, hrefMoves } = await buildEditWrites({
        tree,
        existing: changes,
        edits,
        main: context.main,
        entitlements: this.deps.entitlements,
        assets: this.deps.assets,
        publishedSiteConfig: async () =>
          readPublishedSiteConfig(
            this.deps.store,
            context.main,
            await this.readBaseManifest(context),
          ),
      });

      if (writes.length === 0 || dryRun) {
        return toWorkingDto(context, changes);
      }

      if (!context.branch) {
        const created = await this.deps.branches.getOrCreateHiddenBranch({
          userId: actor.userId,
          projectId,
        });

        if (!created) {
          throw new DocsContentError("branch_not_found", "Branch not found.");
        }

        continue;
      }

      const result = await this.deps.branches.writeChanges({
        userId: actor.userId,
        projectId,
        branchId: context.branch.id,
        expectedRevision: context.branch.revision,
        origin: actor.origin,
        changes: writes,
        hrefMoves,
      });

      if (result === "revision_changed" && expectedRevision !== undefined) {
        throw revisionConflict(
          await this.currentRevision(actor, projectId, branchRef),
        );
      }

      // A publish or a discard can delete the hidden branch while this edit
      // is prepared. The next attempt starts a new hidden branch.
      if (
        result === "revision_changed" ||
        (result === "not_found" && context.branchRef === "main")
      ) {
        continue;
      }

      if (result === "not_found") {
        throw new DocsContentError("branch_not_found", "Branch not found.");
      }

      if (result === "too_many_changes" || result === "branch_too_large") {
        throw new SiteConfigValidationError([createValidationIssue(result)]);
      }

      const updated = await this.resolver.resolve({
        userId: actor.userId,
        projectId,
        branchRef,
      });

      const updatedChanges = await this.listChanges(
        actor,
        projectId,
        branchRef,
      );

      return toWorkingDto(updated, updatedChanges);
    }

    throw new DocsContentError(
      "conflict",
      "The branch changed while this edit was being saved. Try again.",
    );
  }

  private async openView(
    actor: DocsContentActor,
    projectId: string,
    branchRef: string,
    options: DocsContentReadOptions,
  ): Promise<DocsContentView> {
    if (options.published && branchRef !== "main") {
      throw new DocsContentError(
        "invalid",
        "Only main has a published view.",
      );
    }
    if (options.published) {
      const resolved = await this.resolveBranch(actor, projectId, branchRef);
      // The live version, as if the user had no hidden branch.
      const prefix = resolved.main.artifactPrefix;
      return {
        context: { ...resolved, branch: null, basePrefix: prefix },
        changes: [],
        tree: new EffectiveTree(this.deps.store, prefix, [], this.measure),
      };
    }
    const { context, changes } = await this.resolveWithChanges(
      actor,
      projectId,
      branchRef,
    );
    return {
      context,
      changes,
      tree: new EffectiveTree(
        this.deps.store,
        context.basePrefix,
        changes,
        this.measure,
      ),
    };
  }

  private resolveBranch(
    actor: DocsContentActor,
    projectId: string,
    branchRef: string,
  ): Promise<ResolvedBranchContext> {
    return this.measure("db.resolve", () =>
      this.resolver.resolve({ userId: actor.userId, projectId, branchRef }),
    );
  }

  /**
   * Resolves the branch and lists its changes at the same time: both take
   * only the user, the project, and the branch name. A resolve error (for
   * example an unknown branch) still wins over a listing error.
   */
  private async resolveWithChanges(
    actor: DocsContentActor,
    projectId: string,
    branchRef: string,
  ): Promise<{
    context: ResolvedBranchContext;
    changes: readonly StoredBranchChange[];
  }> {
    const listing = this.measure("db.changes", () =>
      this.listChanges(actor, projectId, branchRef),
    );
    // Awaited below. This only stops an unhandled rejection when the
    // resolve fails first.
    listing.catch(() => undefined);
    const context = await this.resolveBranch(actor, projectId, branchRef);
    return { context, changes: await listing };
  }

  private async currentRevision(
    actor: DocsContentActor,
    projectId: string,
    branchRef: string,
  ): Promise<number> {
    const context = await this.resolver.resolve({
      userId: actor.userId,
      projectId,
      branchRef,
    });
    return branchRevision(context);
  }

  private listChanges(
    actor: DocsContentActor,
    projectId: string,
    branch: string,
  ) {
    return this.deps.branches.listChanges({
      userId: actor.userId,
      projectId,
      branch,
    });
  }

  private async readBaseManifest(
    context: ResolvedBranchContext,
  ): Promise<DocsManifest> {
    // Only the manifest: the site settings need nothing else of main.
    return new EffectiveTree(
      this.deps.store,
      context.main.artifactPrefix,
      [],
    ).manifest();
  }
}

/** Main without a hidden branch has nothing saved yet: revision 0. */
function branchRevision(context: ResolvedBranchContext): number {
  return context.branch?.revision ?? 0;
}

function assertExpectedRevision(
  context: ResolvedBranchContext,
  expectedRevision: number | undefined,
): void {
  if (expectedRevision === undefined) return;
  const currentRevision = branchRevision(context);
  if (currentRevision !== expectedRevision) {
    throw revisionConflict(currentRevision);
  }
}

function revisionConflict(currentRevision: number): DocsContentError {
  return new DocsContentError(
    "conflict",
    `The branch is at revision ${currentRevision}. Read it again before you edit it.`,
    { currentRevision },
  );
}

function toWorkingDto(
  context: ResolvedBranchContext,
  changes: readonly StoredBranchChange[],
): DocsContentWorkingDto {
  const branch = context.branch;
  const editedHrefs = new Set<string>();

  for (const change of changes) {
    if (change.kind !== "upsert" || !change.path.startsWith("source/")) {
      continue;
    }

    const path = change.path
      .slice("source/".length)
      .replace(/\/index\.mdx$/, "");
    editedHrefs.add(path === "index.mdx" ? "/" : `/${path}`);
  }

  return {
    branchId: branch?.id ?? null,
    baseVersionId: branch?.baseVersionId ?? context.main.versionId,
    editedHrefs: [...editedHrefs].sort(),
    changeCount: changes.length,
    revision: branchRevision(context),
    createdAt: branch?.createdAt.toISOString() ?? null,
    updatedAt: branch?.updatedAt.toISOString() ?? null,
    isBaseCurrent: !branch || branch.baseVersionId === context.main.versionId,
  };
}

function parseWorkingConfig(content: string) {
  let input: unknown;

  try {
    input = JSON.parse(content);
  } catch {
    throw new DocsContentError(
      "invalid",
      "The working site settings could not be read.",
    );
  }

  return validateSiteConfig(input);
}

function findManifestPage(manifest: DocsManifest, href: string) {
  const target = normalizeHref(href);
  const page = manifest.pages.find(
    (candidate) => normalizeHref(candidate.href) === target,
  );

  if (!page) {
    throw new DocsContentError("not_found", `No page exists at ${target}.`);
  }

  return page;
}
