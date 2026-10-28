import {
  documentSectionSlugFromRelativePath,
  relativeNavigationPathForSection,
} from "@doxahq/contracts/docs-branches";
import { compileSearchArtifact } from "@doxahq/docs-search";
import { DOCS_ARTIFACT_SCHEMA_VERSION } from "./artifact-schema";
import {
  createSiteConfigArtifact,
  type SiteConfigArtifactInput,
} from "./site-config-writer";
import { type DocsManifest } from "./manifest";
import { createRuntimeSearchArtifact } from "./search";

export {
  DOCS_ARTIFACT_SCHEMA_VERSION,
  LEGACY_DOCS_ARTIFACT_SCHEMA_VERSION,
  SUPPORTED_DOCS_ARTIFACT_SCHEMA_VERSIONS,
  docsArtifactSchemaVersionSchema,
  isSupportedDocsArtifactSchemaVersion,
  type DocsArtifactSchemaVersion,
} from "./artifact-schema";
export {
  docsManifestPageSchema,
  docsManifestSchema,
  docsManifestV1Schema,
  docsManifestV2Schema,
  parseDocsManifest,
  parseDocsManifestText,
  type DocsManifest,
  type DocsManifestV1,
  type DocsManifestV2,
  type DocsManifestPage,
  type DocsManifestParseFailureReason,
  type DocsManifestParseResult,
} from "./manifest";
export { findEmbeddedMetadataArtifact } from "./mdx-source";
export {
  SUPPORTED_VERSION_TREE_FORMAT_VERSIONS,
  VERSION_TREE_CONTENT_TYPE,
  VERSION_TREE_FILE_NAME,
  VERSION_TREE_FORMAT,
  VERSION_TREE_FORMAT_VERSION,
  VERSION_TREE_MAX_FILES,
  MemoryVersionByteCache,
  VersionTreeCache,
  VersionTreeError,
  VersionTreeWriter,
  chainVersionByteCaches,
  createVersionTreeReader,
  isSafeVersionTreePath,
  parseImmutableStorageKey,
  parseVersionArtifactKey,
  parseVersionPrefix,
  parseVersionTreeText,
  serializeVersionTree,
  sha256Hex,
  sharedVersionBlobCache,
  sharedVersionTreeCache,
  siteBlobKey,
  siteBlobPrefix,
  toVersionTreeBytes,
  versionTreeEntrySchema,
  versionTreeKey,
  versionTreeSchema,
  writeVersionTree,
  type ImmutableStorageKey,
  type VersionArtifactKeyParts,
  type VersionByteCache,
  type VersionPrefixParts,
  type VersionTree,
  type VersionTreeCommit,
  type VersionTreeEntry,
  type VersionTreeErrorCode,
  type VersionTreeObject,
  type VersionTreeReader,
  type VersionTreeReaderOptions,
  type VersionTreeStorage,
} from "./version-tree";
export {
  createEdgeByteCache,
  workerVersionCaches,
  workersDefaultCache,
  type EdgeByteCacheOptions,
  type EdgeCache,
  type WaitUntil,
  type WorkerVersionCacheOptions,
} from "./version-edge-cache";
export {
  VERSION_BLOB_CACHE_CONTROL,
  VERSION_OBJECT_CACHE_ORIGIN,
  VERSION_TREE_CACHE_CONTROL,
  createVersionObjectStorage,
  parseVersionObjectRequest,
  respondWithVersionObject,
  versionObjectCacheTags,
  versionObjectCacheUrl,
  type VersionObjectFetcher,
  type VersionObjectReadSource,
  type VersionObjectStorageOptions,
} from "./version-object-cache";
export {
  readSiteConfig,
  type SiteConfigStorageReader,
  type SiteConfigReadContext,
} from "./site-config-reader";
export { compileSearchArtifact } from "@doxahq/docs-search";
export {
  createRuntimeSearchArtifact,
  createRuntimeSearchDocument,
  runtimeSearchArtifactSchema,
  runtimeSearchDocumentSchema,
  updateRuntimeSearchDocument,
  type RuntimeSearchArtifact,
  type RuntimeSearchDocument,
} from "./search";

export interface RuntimeDocsPageInput {
  title: string;
  route: string;
  content: string;
  /** Exact generated filename used by the agent navigation manifest. */
  navigationPath?: string;
}

export interface RuntimeDocsNavigationGroupInput {
  heading: string;
  items: string[];
}

export interface RuntimeDocsNavigationSectionInput {
  slug: string;
  items: string[];
  groups?: RuntimeDocsNavigationGroupInput[];
}

export interface RuntimeDocsSectionMetadataInput {
  label: string;
  kind?: "documentation" | "reference" | "development";
  layout?: "docs" | "reference";
}

export interface RuntimeDocsNavigationInput {
  sections: RuntimeDocsNavigationSectionInput[];
  icons?: Record<string, string>;
  navTitles?: Record<string, string>;
  navBadges?: Record<string, string>;
  sectionMetadata?: Record<string, RuntimeDocsSectionMetadataInput>;
}

export interface RuntimeDocsFeatureInput {
  apiPlayground?: boolean;
}

export interface RuntimeDocsArtifactFile {
  path: string;
  content: string;
  contentType: string;
}

export interface RuntimeDocsArtifactBundle {
  manifest: DocsManifest;
  files: RuntimeDocsArtifactFile[];
}

export function buildArtifactPrefix(siteId: string, versionId: string): string {
  return `sites/${siteId}/versions/${versionId}`;
}

/**
 * The page href of a page source path, the inverse of `sourcePathForHref`.
 * Null for a path that is not a page source.
 */
export function hrefForSourcePath(path: string): string | null {
  if (path === "source/index.mdx") return "/";
  const match = /^source\/(.+)\/index\.mdx$/.exec(path);
  return match ? `/${match[1]}` : null;
}

export function sourcePathForHref(href: string): string {
  const normalized = href.replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized ? `source/${normalized}/index.mdx` : "source/index.mdx";
}

export function manifestPathForPrefix(prefix: string): string {
  return `${prefix}/manifest.json`;
}

export function documentsPathForPrefix(prefix: string): string {
  return `${prefix}/settings/documents.json`;
}

export function navigationPathForSection(prefix: string, slug: string): string {
  return `${prefix}/${relativeNavigationPathForSection(slug)}`;
}

export function documentSectionSlug(
  key: string,
  prefix: string,
): string | null {
  if (!key.startsWith(`${prefix}/`)) return null;
  return documentSectionSlugFromRelativePath(key.slice(prefix.length + 1));
}

export function sectionsPathForPrefix(prefix: string): string {
  return `${prefix}/settings/sections.json`;
}

export function featuresPathForPrefix(prefix: string): string {
  return `${prefix}/settings/features.json`;
}

export function searchIndexPathForPrefix(prefix: string): string {
  return `${prefix}/search/index.json`;
}

export function compiledSearchIndexPathForPrefix(prefix: string): string {
  return `${prefix}/search/minisearch.json`;
}

/**
 * The state prefix of an edited version whose base had no generation state.
 * The baseline resolvers require `sites/<siteId>/generation-state/<id>`, so
 * this prefix makes the version ineligible, and the next generation analyzes
 * the repository from scratch. An edited version whose base had generation
 * state keeps the base's prefix instead, and stays a baseline.
 */
export function contentVersionStatePrefix(
  siteId: string,
  versionId: string,
): string {
  return `sites/${siteId}/content-versions/${versionId}`;
}

const GENERATION_STATE_VERSION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * The version whose generation state `prefix` names, or null when `prefix`
 * is not a generation state of this site. A version usually names its own
 * state. A reviewed generation publishes a new version that names the state
 * of the staged version the run wrote.
 */
export function generationStateOwnerVersionId(
  siteId: string,
  prefix: string,
): string | null {
  const root = `sites/${siteId}/generation-state/`;
  if (!prefix.startsWith(root)) {
    return null;
  }

  const versionId = prefix.slice(root.length);
  return GENERATION_STATE_VERSION_SEGMENT.test(versionId) ? versionId : null;
}

export async function createStarterDocsManifest(input: {
  siteId: string;
  versionId: string;
  projectSlug: string;
  projectName: string;
}): Promise<DocsManifest> {
  return {
    schemaVersion: DOCS_ARTIFACT_SCHEMA_VERSION,
    siteConfig: (await createSiteConfigArtifact(input)).manifestEntry,
    siteId: input.siteId,
    versionId: input.versionId,
    projectSlug: input.projectSlug,
    generatedAt: new Date().toISOString(),
    pages: [
      {
        title: input.projectName,
        href: "/",
        sourcePath: "source/index.mdx",
      },
      {
        title: "Getting Started",
        href: "/getting-started",
        sourcePath: "source/getting-started/index.mdx",
      },
    ],
  };
}

export function createStarterDocuments(projectName: string) {
  return [
    {
      title: projectName,
      href: "/",
    },
    {
      title: "Getting Started",
      href: "/getting-started",
    },
  ];
}

export async function createRuntimeDocsArtifacts(
  input: SiteConfigArtifactInput & {
    siteId: string;
    versionId: string;
    projectSlug: string;
    projectName: string;
    pages: RuntimeDocsPageInput[];
    navigation?: RuntimeDocsNavigationInput | null;
    features?: RuntimeDocsFeatureInput;
  },
): Promise<RuntimeDocsArtifactBundle> {
  const pages = input.pages.map((page) => ({
    ...page,
    route: normalizeHref(page.route),
  }));
  const siteConfig = await createSiteConfigArtifact(input);

  const manifest: DocsManifest = {
    schemaVersion: DOCS_ARTIFACT_SCHEMA_VERSION,
    siteConfig: siteConfig.manifestEntry,
    siteId: input.siteId,
    versionId: input.versionId,
    projectSlug: input.projectSlug,
    generatedAt: new Date().toISOString(),
    pages: pages.map((page) => ({
      title: page.title,
      href: page.route,
      sourcePath: sourcePathForHref(page.route),
    })),
  };

  const sourceFiles = pages.map((page) => ({
    path: sourcePathForHref(page.route),
    content: page.content,
    contentType: "text/plain; charset=utf-8",
  }));
  const settingsFiles = input.navigation
    ? createStructuredSettingsFiles(pages, input.navigation)
    : createFlatSettingsFiles(pages);
  const searchArtifact = createRuntimeSearchArtifact({
    contentVersion: input.versionId,
    pages,
    navigation: input.navigation,
  });

  return {
    manifest,
    files: [
      ...sourceFiles,
      ...settingsFiles,
      siteConfig.file,
      {
        path: "search/index.json",
        content: `${JSON.stringify(searchArtifact, null, 2)}\n`,
        contentType: "application/json; charset=utf-8",
      },
      {
        path: "search/minisearch.json",
        content: `${JSON.stringify(compileSearchArtifact(searchArtifact))}\n`,
        contentType: "application/json; charset=utf-8",
      },
      {
        path: "manifest.json",
        content: `${JSON.stringify(manifest, null, 2)}\n`,
        contentType: "application/json; charset=utf-8",
      },
    ],
  };
}

interface RuntimeNavPageNode {
  title: string;
  href: string;
  icon?: string;
  badge?: string;
}

type RuntimeNavNode =
  | RuntimeNavPageNode
  | { heading: string }
  | { spacer: true };

/**
 * The navigation heading over the pages that no group lists, in a section
 * that has groups. A reader of the navigation treats it as no group.
 */
export const UNGROUPED_NAVIGATION_HEADING = "Other";

function createFlatSettingsFiles(
  pages: RuntimeDocsPageInput[],
): RuntimeDocsArtifactFile[] {
  return [
    jsonArtifact(
      "settings/documents.json",
      pages.map((page) => ({ title: page.title, href: page.route })),
    ),
    jsonArtifact("settings/sections.json", [
      { slug: "default", label: "Docs" },
    ]),
  ];
}

function createStructuredSettingsFiles(
  pages: RuntimeDocsPageInput[],
  navigation: RuntimeDocsNavigationInput,
): RuntimeDocsArtifactFile[] {
  const pageByNavigationPath = new Map<string, RuntimeDocsPageInput>();
  for (const page of pages) {
    if (page.navigationPath) {
      pageByNavigationPath.set(
        normalizeNavigationPath(page.navigationPath),
        page,
      );
    }
  }

  const sections = navigation.sections.map((section) => {
    const metadata = navigation.sectionMetadata?.[section.slug];
    return {
      slug: section.slug,
      label: metadata?.label ?? titleizeSlug(section.slug),
      ...(section.slug === "default" ? { default: true as const } : {}),
      ...(metadata?.kind ? { kind: metadata.kind } : {}),
      ...(metadata?.layout ? { layout: metadata.layout } : {}),
    };
  });
  const consumed = new Set<string>();
  const documentsBySection = new Map<string, RuntimeNavNode[]>();

  for (const section of navigation.sections) {
    const nodes: RuntimeNavNode[] = [];
    const appendPage = (filename: string): boolean => {
      const normalizedFilename = normalizeNavigationPath(filename);
      if (consumed.has(normalizedFilename)) return false;
      const page = pageByNavigationPath.get(normalizedFilename);
      if (!page) return false;
      nodes.push(navigationPageNode(page, normalizedFilename, navigation));
      consumed.add(normalizedFilename);
      return true;
    };

    for (const group of section.groups ?? []) {
      const groupPages = group.items.filter((filename) => {
        const normalizedFilename = normalizeNavigationPath(filename);
        return (
          !consumed.has(normalizedFilename) &&
          pageByNavigationPath.has(normalizedFilename)
        );
      });
      if (groupPages.length === 0) continue;
      if (nodes.length > 0) nodes.push({ spacer: true });
      nodes.push({ heading: group.heading });
      for (const filename of groupPages) appendPage(filename);
    }

    const ungroupedItems = section.items.filter((filename) => {
      const normalizedFilename = normalizeNavigationPath(filename);
      return (
        !consumed.has(normalizedFilename) &&
        pageByNavigationPath.has(normalizedFilename)
      );
    });
    if (ungroupedItems.length > 0 && (section.groups?.length ?? 0) > 0) {
      if (nodes.length > 0) nodes.push({ spacer: true });
      nodes.push({ heading: UNGROUPED_NAVIGATION_HEADING });
    }
    for (const filename of ungroupedItems) appendPage(filename);

    documentsBySection.set(section.slug, nodes);
  }

  appendUncoveredPages(
    pages,
    navigation,
    sections,
    documentsBySection,
    consumed,
  );

  return [
    ...sections.map((section) =>
      jsonArtifact(
        section.slug === "default"
          ? "settings/documents.json"
          : `settings/documents.${section.slug}.json`,
        documentsBySection.get(section.slug) ?? [],
      ),
    ),
    jsonArtifact("settings/sections.json", sections),
  ];
}

function appendUncoveredPages(
  pages: RuntimeDocsPageInput[],
  navigation: RuntimeDocsNavigationInput,
  sections: Array<{ slug: string }>,
  documentsBySection: Map<string, RuntimeNavNode[]>,
  consumed: Set<string>,
): void {
  const sectionSlugs = new Set(sections.map((section) => section.slug));
  for (const page of pages) {
    if (!page.navigationPath) continue;
    const navigationPath = normalizeNavigationPath(page.navigationPath);
    if (consumed.has(navigationPath)) continue;

    const firstPathSegment = navigationPath?.split("/")[0];
    const firstRouteSegment = normalizeHref(page.route)
      .split("/")
      .filter(Boolean)[0];
    const sectionSlug =
      firstPathSegment && sectionSlugs.has(firstPathSegment)
        ? firstPathSegment
        : firstRouteSegment && sectionSlugs.has(firstRouteSegment)
          ? firstRouteSegment
          : "default";
    const nodes = documentsBySection.get(sectionSlug);
    if (!nodes) continue;
    if (!nodes.some((node) => "heading" in node && node.heading === UNGROUPED_NAVIGATION_HEADING)) {
      if (nodes.length > 0) nodes.push({ spacer: true });
      nodes.push({ heading: UNGROUPED_NAVIGATION_HEADING });
    }
    nodes.push(navigationPageNode(page, navigationPath, navigation));
    consumed.add(navigationPath);
  }
}

function navigationPageNode(
  page: RuntimeDocsPageInput,
  filename: string,
  navigation: RuntimeDocsNavigationInput,
): RuntimeNavPageNode {
  const icon = navigation.icons?.[filename];
  const badge = navigation.navBadges?.[filename];
  return {
    title: navigation.navTitles?.[filename] ?? page.title,
    href: page.route,
    ...(icon ? { icon } : {}),
    ...(badge ? { badge } : {}),
  };
}

function normalizeNavigationPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function titleizeSlug(slug: string): string {
  if (slug === "default") return "Docs";
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function jsonArtifact(path: string, value: unknown): RuntimeDocsArtifactFile {
  return {
    path,
    content: `${JSON.stringify(value, null, 2)}\n`,
    contentType: "application/json; charset=utf-8",
  };
}

export function normalizeHref(value: string): string {
  const clean = value
    .replace(/\\/g, "/")
    .replace(/\.(mdx?|tsx?|jsx?)$/i, "")
    .replace(/\/index$/i, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return clean ? `/${clean}` : "/";
}
export {
  matchPages,
  pageBody,
  type MatchablePage,
  type PageMatch,
  type PageMatching,
  type PageMatchReason,
} from "./page-matching";
