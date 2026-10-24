import {
  classifyBranchPath,
  documentSectionSlugFromRelativePath,
  type DocsBranchAssetDiff,
  type DocsBranchDiff,
  type DocsBranchFileChange,
  type DocsBranchPageDiff,
  type DocsBranchPageSources,
  type DocsBranchSettingsDiff,
  type DocsBranchStructureDiff,
} from "@doxahq/contracts/docs-branches";
import { docsAssetUrlPath } from "@doxahq/contracts/docs-assets";
import { normalizeHref, sourcePathForHref } from "@doxahq/docs-engine";
import type { Env } from "../../env";
import {
  DocsBranchesRepository,
  type DocsBranchStore,
  type StoredBranchChange,
} from "../../repositories/docs-branches";
import { mapWithConcurrency } from "../../utils/concurrency";
import { parseDocsManifest, readFrontmatterTitle } from "../docs-content/artifacts";
import { DocsContentError } from "../docs-content/errors";
import {
  createR2DocsContentStore,
  type DocsContentStore,
  withRequestReadCache,
} from "../docs-content/store";
import { branchAssets, isAssetPath } from "./assets/branch-assets";
import { BranchResolver, type ResolvedBranchContext } from "./branch-resolver";
import { hrefForSourcePath } from "./page-href";
import { cappedUnifiedDiff, formatJsonForDiff } from "./unified-diff";

const READ_CONCURRENCY = 16;
const MANIFEST_PATH = "manifest.json";

interface BranchScopedInput {
  userId: string;
  projectId: string;
  branch: string;
}

/** One changed file with both of its sides. */
interface ComparedFile {
  path: string;
  change: DocsBranchFileChange;
  before: string | null;
  after: string | null;
}

interface LoadedDiff {
  context: ResolvedBranchContext;
  baseVersionId: string;
  files: ComparedFile[];
  assets: DocsBranchAssetDiff[];
  titles: PageTitles;
}

type BranchDiffStore = Pick<DocsBranchStore, "resolveForUser" | "listChanges">;

/**
 * Compares a branch with its base version: the main version the branch
 * started from or last synchronized with. That is what a publish of the
 * branch changes, since a publish requires the base to be the live main.
 * The approve panel and the `get_branch_diff` tool both read this service.
 */
export class DocsBranchDiffService {
  private readonly resolver: BranchResolver;

  constructor(
    private readonly branches: BranchDiffStore,
    private readonly store: Pick<DocsContentStore, "read" | "listKeys">,
  ) {
    this.resolver = new BranchResolver(branches);
  }

  static fromEnv(env: Env): DocsBranchDiffService {
    return new DocsBranchDiffService(
      new DocsBranchesRepository(env),
      withRequestReadCache(createR2DocsContentStore(env.DOCS_BUCKET)),
    );
  }

  async diff(input: BranchScopedInput): Promise<DocsBranchDiff> {
    const loaded = await this.load(input);
    const pages: DocsBranchPageDiff[] = [];
    const structure: DocsBranchStructureDiff[] = [];
    let siteSettings: DocsBranchSettingsDiff | null = null;

    for (const file of loaded.files) {
      const unit = classifyBranchPath(file.path);

      if (unit === "page") {
        const href = hrefForSourcePath(file.path);
        pages.push({
          href,
          title: loaded.titles.of(href, file),
          change: file.change,
          ...cappedUnifiedDiff(file),
        });
      } else if (unit === "structure") {
        structure.push({
          path: file.path,
          label: structureLabel(file.path),
          change: file.change,
          ...cappedUnifiedDiff(asJsonFile(file)),
        });
      } else if (unit === "site_settings") {
        siteSettings = {
          change: file.change,
          ...cappedUnifiedDiff(asJsonFile(file)),
        };
      }
    }

    return {
      baseVersionId: loaded.baseVersionId,
      mainVersionId: loaded.context.main.versionId,
      behind: loaded.baseVersionId !== loaded.context.main.versionId,
      pages: pages.sort((left, right) => left.href.localeCompare(right.href)),
      structure,
      siteSettings,
      assets: loaded.assets,
    };
  }

  /** Both full sources of one changed page. */
  async pageSources(
    input: BranchScopedInput & { href: string },
  ): Promise<DocsBranchPageSources> {
    const href = normalizeHref(input.href);
    const loaded = await this.load(input);
    const path = sourcePathForHref(href);
    const file = loaded.files.find((candidate) => candidate.path === path);

    if (!file) {
      throw new DocsContentError(
        "not_found",
        "This page has no changes on the branch.",
      );
    }

    return {
      href,
      title: loaded.titles.of(href, file),
      change: file.change,
      before: file.before,
      after: file.after,
    };
  }

  private async load(input: BranchScopedInput): Promise<LoadedDiff> {
    const context = await this.resolver.resolve({
      userId: input.userId,
      projectId: input.projectId,
      branchRef: input.branch,
    });
    const changes = context.branch
      ? await this.branches.listChanges(input)
      : [];
    const compared = await mapWithConcurrency(
      changes.filter((change) => !isAssetPath(change.path)),
      READ_CONCURRENCY,
      (change) => this.compare(context.basePrefix, change),
    );
    const files = compared.filter(
      (file): file is ComparedFile => file !== null,
    );
    const baseManifest = await this.store.read(
      `${context.basePrefix}/${MANIFEST_PATH}`,
    );
    const branchManifest =
      files.find((file) => file.path === MANIFEST_PATH)?.after ?? baseManifest;

    return {
      context,
      baseVersionId: context.branch?.baseVersionId ?? context.main.versionId,
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
      assets: await this.compareAssets(context.basePrefix, changes),
      titles: new PageTitles(baseManifest, branchManifest),
    };
  }

  /**
   * Images have no text diff. One listing of the base images tells an added
   * image from a replaced one, without reading any image.
   */
  private async compareAssets(
    basePrefix: string,
    changes: readonly StoredBranchChange[],
  ): Promise<DocsBranchAssetDiff[]> {
    const assets = branchAssets(changes);
    if (assets.length === 0) return [];
    const baseKeys = new Set(
      await this.store.listKeys(`${basePrefix}/assets/`),
    );
    return assets
      .map(
        (asset): DocsBranchAssetDiff => ({
          path: docsAssetUrlPath(asset.name),
          change: baseKeys.has(`${basePrefix}/${asset.path}`)
            ? "edited"
            : "added",
          contentType: asset.pointer.contentType,
          size: asset.pointer.size,
        }),
      )
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  private async compare(
    basePrefix: string,
    change: StoredBranchChange,
  ): Promise<ComparedFile | null> {
    const before = await this.store.read(`${basePrefix}/${change.path}`);
    const after = change.kind === "upsert" ? change.content : null;
    const kind = fileChange(before, after);
    return kind ? { path: change.path, change: kind, before, after } : null;
  }
}

/** Null when both sides match: the row changes nothing. */
function fileChange(
  before: string | null,
  after: string | null,
): DocsBranchFileChange | null {
  if (before === after) return null;
  if (before === null) return "added";
  if (after === null) return "deleted";
  return "edited";
}

/**
 * A page title as a publish would show it: the frontmatter title of the
 * page, else its manifest entry on the side where the page exists.
 */
class PageTitles {
  private readonly base: Map<string, string>;
  private readonly branch: Map<string, string>;

  constructor(baseManifest: string | null, branchManifest: string | null) {
    this.base = titlesOf(baseManifest);
    this.branch = titlesOf(branchManifest);
  }

  of(href: string, file: ComparedFile): string {
    const source = file.after ?? file.before;
    const manifest = file.after === null ? this.base : this.branch;
    return (
      (source ? readFrontmatterTitle(source) : null) ??
      manifest.get(href) ??
      this.base.get(href) ??
      href
    );
  }
}

function titlesOf(raw: string | null): Map<string, string> {
  const manifest = raw ? parseDocsManifest(raw) : null;
  return new Map(
    (manifest?.pages ?? []).map((page) => [normalizeHref(page.href), page.title]),
  );
}

function structureLabel(path: string): string {
  if (path === MANIFEST_PATH) return "Page list";
  if (path === "settings/sections.json") return "Sections";
  const section = documentSectionSlugFromRelativePath(path);
  return section && section !== "default"
    ? `Navigation (${section})`
    : "Navigation";
}

function asJsonFile(file: ComparedFile): ComparedFile {
  return {
    ...file,
    before: formatJsonForDiff(file.before),
    after: formatJsonForDiff(file.after),
  };
}
