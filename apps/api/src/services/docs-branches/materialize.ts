import {
  compileSearchArtifact,
  compiledSearchIndexPathForPrefix,
  createRuntimeSearchArtifact,
  manifestPathForPrefix,
  normalizeHref,
  runtimeSearchArtifactSchema,
  searchIndexPathForPrefix,
  sourcePathForHref,
} from "@doxahq/docs-engine";
import type { ResolvedSiteConfig } from "@doxahq/site-config";
import type { DocsPublicationSummary } from "@doxahq/contracts/docs-branches";
import type { StoredBranchChange } from "../../repositories/docs-branches";
import {
  applyManifestEdits,
  applyNavigationTitles,
  applySearchIndexEdits,
  readSearchIndexHrefs,
  readFrontmatterTitle,
  toJsonArtifact,
  type EditedContentPage,
} from "../docs-content/artifacts";
import { DocsContentError } from "../docs-content/errors";
import type { DocsContentStore } from "../docs-content/store";
import { upgradeArtifactToCurrentSchema } from "../docs-content/upgrade-artifact";
import { mapWithConcurrency } from "../../utils/concurrency";
import { branchAssetFolderPrefix } from "./assets/asset-pointer";
import { branchAssets } from "./assets/branch-assets";
import { EffectiveTree } from "./effective-tree";

const ARTIFACT_CONCURRENCY = 8;

export interface MaterializeInput {
  siteId: string;
  base: { versionId: string; artifactPrefix: string };
  changes: readonly StoredBranchChange[];
  targetVersionId: string;
  generatedAt: string;
  siteConfig: ResolvedSiteConfig;
}

export interface MaterializeResult {
  artifactPrefix: string;
  manifestPath: string;
  summary: DocsPublicationSummary;
}

/**
 * Writes a complete immutable version before the database head moves.
 *
 * The new version reuses every unchanged file of its base: the storage copies
 * the tree entry and writes no blob. Only changed pages and the rebuilt
 * manifest, settings, navigation, and search files can produce new blobs.
 */
export function createMaterializer(deps: { store: DocsContentStore }) {
  return async (input: MaterializeInput): Promise<MaterializeResult> => {
    const { store } = deps;
    const basePrefix = input.base.artifactPrefix;
    const tree = new EffectiveTree(store, basePrefix, input.changes);
    const effective = await tree.content();

    const upgraded = await upgradeArtifactToCurrentSchema(
      effective.manifest,
      input.siteConfig,
    );
    if (!upgraded.siteConfigJson) {
      throw new DocsContentError(
        "invalid",
        "The site settings writer is unavailable.",
      );
    }

    if (effective.navigation.documentsBySection.size === 0) {
      throw new DocsContentError(
        "invalid",
        "The documentation navigation could not be read.",
      );
    }

    // Only changed pages are read. An unchanged page keeps its title and its
    // search entry from the base version. A page without a search entry, or
    // every page when the base index is unreadable, is read to build one.
    const changedPaths = new Set(input.changes.map(({ path }) => path));
    const baseSearch = await store.read(searchIndexPathForPrefix(basePrefix));
    const indexedHrefs = readSearchIndexHrefs(baseSearch);
    const pages: EditedContentPage[] = await mapWithConcurrency(
      effective.manifest.pages,
      ARTIFACT_CONCURRENCY,
      async (page) => {
        const href = normalizeHref(page.href);
        const sourcePath = page.sourcePath || sourcePathForHref(href);
        const changed = changedPaths.has(sourcePath);

        if (!changed && indexedHrefs?.has(href)) {
          return { href, sourcePath, content: null, title: page.title };
        }

        const content = await tree.read(sourcePath);

        if (content === null) {
          throw new DocsContentError(
            "invalid",
            `The page at ${href} has no source content.`,
          );
        }

        return {
          href,
          sourcePath,
          content,
          title: changed
            ? (readFrontmatterTitle(content) ?? page.title)
            : page.title,
        };
      },
    );
    const titlesByHref = new Map(
      pages
        .filter(({ sourcePath }) => changedPaths.has(sourcePath))
        .map((page) => [page.href, page.title]),
    );
    const version = await store.openVersion({
      siteId: input.siteId,
      versionId: input.targetVersionId,
      basePrefix,
    });
    const targetPrefix = version.artifactPrefix;
    const pathOf = (key: string) => key.slice(targetPrefix.length + 1);

    const searchContent =
      (baseSearch &&
        applySearchIndexEdits(baseSearch, {
          contentVersion: input.targetVersionId,
          pages,
        })) ||
      toJsonArtifact(
        createRuntimeSearchArtifact({
          contentVersion: input.targetVersionId,
          // The base index is unreadable, so every page was read above.
          pages: pages.map((page) => ({
            title: page.title,
            route: page.href,
            content: page.content ?? "",
          })),
        }),
      );
    const search = runtimeSearchArtifactSchema.parse(JSON.parse(searchContent));
    const rebuilt: [path: string, content: string][] = [
      [
        pathOf(manifestPathForPrefix(targetPrefix)),
        toJsonArtifact(
          applyManifestEdits(upgraded.manifest, {
            versionId: input.targetVersionId,
            generatedAt: input.generatedAt,
            titlesByHref,
          }),
        ),
      ],
      ["settings/site.json", upgraded.siteConfigJson],
      [
        "settings/sections.json",
        toJsonArtifact(effective.navigation.sectionsArtifact),
      ],
      ...[...effective.navigation.documentsBySection].map(
        ([slug, nodes]): [string, string] => {
          const content = toJsonArtifact(nodes);
          return [
            slug === "default"
              ? "settings/documents.json"
              : `settings/documents.${slug}.json`,
            applyNavigationTitles(content, titlesByHref) ?? content,
          ];
        },
      ),
      [pathOf(searchIndexPathForPrefix(targetPrefix)), searchContent],
      [
        pathOf(compiledSearchIndexPathForPrefix(targetPrefix)),
        toJsonArtifact(compileSearchArtifact(search)),
      ],
    ];

    // The tree is written at the commit, so the order of these writes does not
    // matter. An unchanged page reuses its base blob without a read or write,
    // and a branch image reuses the blob of its upload folder.
    await Promise.all([
      mapWithConcurrency(
        branchAssets(input.changes),
        ARTIFACT_CONCURRENCY,
        (asset) =>
          version.copyFrom(
            branchAssetFolderPrefix(input.siteId, asset.pointer),
            asset.path,
          ),
      ),
      mapWithConcurrency(pages, ARTIFACT_CONCURRENCY, (page) =>
        changedPaths.has(page.sourcePath) && page.content !== null
          ? version.put(page.sourcePath, page.content)
          : version.copy(page.sourcePath),
      ),
      mapWithConcurrency(rebuilt, ARTIFACT_CONCURRENCY, ([path, content]) =>
        version.put(path, content),
      ),
    ]);

    const baseKeys = await store.listKeys(`${basePrefix}/`);

    await mapWithConcurrency(baseKeys, ARTIFACT_CONCURRENCY, async (key) => {
      const path = key.slice(basePrefix.length + 1);

      // A changed path is written above; a deleted one stays out.
      if (!isRebuiltArtifact(path) && !changedPaths.has(path)) {
        await version.copy(path);
      }
    });

    const committed = await version.commit();

    const changedPages = input.changes.filter(({ path }) =>
      path.startsWith("source/"),
    );

    return {
      artifactPrefix: committed.artifactPrefix,
      manifestPath: committed.manifestPath,
      summary: {
        changedPageCount: changedPages.length,
        pageTitles: pages
          .filter((page) =>
            changedPages.some(({ path }) => path === page.sourcePath),
          )
          .map((page) => page.title.slice(0, 200))
          .slice(0, 20),
        structureChanged: input.changes.some(
          ({ path }) =>
            path === "manifest.json" ||
            path.startsWith("settings/documents") ||
            path === "settings/sections.json",
        ),
        siteSettingsChanged: input.changes.some(
          ({ path }) => path === "settings/site.json",
        ),
      },
    };
  };
}

function isRebuiltArtifact(path: string): boolean {
  return (
    path.startsWith("source/") ||
    path === "manifest.json" ||
    path === "settings/site.json" ||
    path === "settings/sections.json" ||
    path === "settings/documents.json" ||
    /^settings\/documents\.[^.]+\.json$/.test(path) ||
    path === "settings/features.json" ||
    path.startsWith("search/")
  );
}
