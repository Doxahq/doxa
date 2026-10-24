import { basename, dirname, join } from "path";
import { fileExists, readTextFile, scanGlob } from "./runtime";
import type {
  DocPage,
  DocSection,
  DocumentationCollection,
  DocumentationCollectionItem,
  DocumentationStructure,
  ProjectAnalysis,
  SourceEvidence,
} from "../types";
import { slugify } from "../doxa-agent/structure-utils";
import {
  ProjectPathAccessError,
  resolveProjectPath,
} from "../core/tools/project-path";
import { MIN_DOCUMENTATION_COLLECTION_ITEMS } from "./documentation-collection-policy";

const INDEX_NAMES = new Set(["index", "readme", "overview"]);
const MIN_PAGE_DESCRIPTION_LENGTH = 40;

interface ClaimedCollectionPages {
  itemPages: Map<string, DocPage>;
  insertionIndex: number;
}

interface PackageCollectionCandidate {
  collectionId: string;
  collectionTitle: string;
  item: DocumentationCollectionItem;
}

function titleize(value: string): string {
  return value
    .replace(/^@[^/]+\//, "")
    .replace(/\.(mdx?|tsx?|jsx?)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function pluralize(value: string): string {
  return value.endsWith("s") ? value : `${value}s`;
}

function singularize(value: string): string {
  return value.endsWith("s") ? value.slice(0, -1) : value;
}

function cleanItemTitle(rawTitle: string, collectionTitle: string): string {
  const singular = singularize(collectionTitle);
  const cleaned = rawTitle.replace(new RegExp(`\\s+${singular}$`, "i"), "").trim();
  return cleaned || rawTitle;
}

function source(path: string, kind: SourceEvidence["kind"], title?: string): SourceEvidence {
  return { path, kind, title };
}

function uniqueEvidence(evidence: SourceEvidence[]): SourceEvidence[] {
  const seen = new Set<string>();
  const result: SourceEvidence[] = [];
  for (const item of evidence) {
    if (!item.path || seen.has(item.path)) continue;
    seen.add(item.path);
    result.push(item);
  }
  return result;
}

function mergeItems(
  existing: DocumentationCollectionItem | undefined,
  incoming: DocumentationCollectionItem,
): DocumentationCollectionItem {
  if (!existing) return { ...incoming, sourceEvidence: uniqueEvidence(incoming.sourceEvidence) };
  return {
    ...existing,
    description: existing.description || incoming.description,
    packageName: existing.packageName || incoming.packageName,
    installCommand: existing.installCommand || incoming.installCommand,
    sourceEvidence: uniqueEvidence([...existing.sourceEvidence, ...incoming.sourceEvidence]),
  };
}

async function readProjectJson(
  cwd: string,
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    const text = await readTextFile(await resolveProjectPath(cwd, path));
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch (error) {
    if (error instanceof ProjectPathAccessError) throw error;
    return null;
  }
}

function extractDocTitle(content: string, filePath: string): string {
  const frontmatterTitle = content.match(/^---\s*[\s\S]*?\ntitle:\s*["']?([^"'\n]+)["']?[\s\S]*?\n---/);
  if (frontmatterTitle?.[1]) return frontmatterTitle[1].trim();

  const heading = content.match(/^#\s+(.+)$/m);
  if (heading?.[1]) return heading[1].replace(/<[^>]+>/g, "").trim();

  return titleize(basename(filePath));
}

function extractDocDescription(content: string): string | undefined {
  const frontmatterDescription = content.match(/^---\s*[\s\S]*?\ndescription:\s*["']?([^"'\n]+)["']?[\s\S]*?\n---/);
  if (frontmatterDescription?.[1]) return frontmatterDescription[1].trim();

  const paragraph = content
    .replace(/^---\s*[\s\S]*?\n---\s*/, "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) =>
      line.length > 40 &&
      !line.startsWith("#") &&
      !line.startsWith("import ") &&
      !line.startsWith("export ") &&
      !line.startsWith("<")
    );
  return paragraph?.slice(0, 180);
}

async function discoverDocsCollections(cwd: string): Promise<Map<string, DocumentationCollection>> {
  const byDir = new Map<string, string[]>();

  for (const match of await scanGlob("docs/**/*.{md,mdx}", cwd)) {
    const name = basename(match).replace(/\.(md|mdx)$/i, "");
    if (INDEX_NAMES.has(name.toLowerCase())) continue;
    const dir = dirname(match);
    const existing = byDir.get(dir) ?? [];
    existing.push(match);
    byDir.set(dir, existing);
  }

  const collections = new Map<string, DocumentationCollection>();
  for (const [dir, files] of byDir.entries()) {
    if (files.length < MIN_DOCUMENTATION_COLLECTION_ITEMS) continue;

    const dirName = basename(dir);
    const collectionId = slugify(pluralize(dirName));
    const items: DocumentationCollectionItem[] = [];

    for (const file of files.sort()) {
      const absolute = await resolveProjectPath(cwd, file);
      const content = await readTextFile(absolute);
      const slug = slugify(basename(file).replace(/\.(md|mdx)$/i, ""));
      const rawTitle = extractDocTitle(content, file);
      items.push({
        id: `${collectionId}/${slug}`,
        title: cleanItemTitle(rawTitle, titleize(dirName)),
        slug,
        description: extractDocDescription(content),
        sourceEvidence: [source(file, "docs", "Source documentation")],
      });
    }

    collections.set(collectionId, {
      id: collectionId,
      title: titleize(dirName),
      description: `User-facing ${titleize(dirName).toLowerCase()} documented in the source project.`,
      kind: "docs",
      sourceEvidence: [source(dir, "docs", "Collection directory")],
      items,
    });
  }

  return collections;
}

function packageCandidateFromDir(packageDir: string, packageName?: string): {
  collectionId: string;
  collectionTitle: string;
  itemSlug: string;
  itemTitle: string;
} | null {
  const dirName = basename(packageDir);
  const match = dirName.match(/^([a-z][a-z0-9]*s?)-(.+)$/i);
  if (!match) return null;

  const collectionBase = pluralize(match[1].replace(/s$/, ""));
  const itemSlug = slugify(match[2]);
  const packageSuffix = packageName?.match(/\/?([^/@]+?)-(?:adapter|provider|plugin|integration|sdk)$/i)?.[1];
  const titleSlug = packageSuffix ? slugify(packageSuffix) : itemSlug;

  return {
    collectionId: slugify(collectionBase),
    collectionTitle: titleize(collectionBase),
    itemSlug,
    itemTitle: titleize(titleSlug),
  };
}

async function discoverPackageCollections(cwd: string): Promise<PackageCollectionCandidate[]> {
  const candidates: PackageCollectionCandidate[] = [];

  for (const match of await scanGlob("packages/*/package.json", cwd)) {
    const pkg = await readProjectJson(cwd, match);
    if (!pkg) continue;

    const packageName = typeof pkg.name === "string" ? pkg.name : undefined;
    const privatePackage = pkg.private === true;
    const packageDir = dirname(match);
    const candidate = packageCandidateFromDir(packageDir, packageName);
    if (!candidate || privatePackage || !packageName) continue;

    const evidence = [source(match, "package", "Package manifest")];
    const readmePath = join(packageDir, "README.md");
    if (await fileExists(await resolveProjectPath(cwd, readmePath))) {
      evidence.push(source(readmePath, "readme", "Package README"));
    }

    candidates.push({
      collectionId: candidate.collectionId,
      collectionTitle: candidate.collectionTitle,
      item: {
        id: `${candidate.collectionId}/${candidate.itemSlug}`,
        title: candidate.itemTitle,
        slug: candidate.itemSlug,
        description: typeof pkg.description === "string" ? pkg.description : undefined,
        packageName,
        installCommand: `npm install ${packageName}`,
        sourceEvidence: evidence,
      },
    });
  }

  return candidates;
}

function mergePackageCandidates(
  collections: Map<string, DocumentationCollection>,
  packageCandidates: PackageCollectionCandidate[],
): void {
  const packageGroups = new Map<string, PackageCollectionCandidate[]>();
  for (const candidate of packageCandidates) {
    const group = packageGroups.get(candidate.collectionId) ?? [];
    group.push(candidate);
    packageGroups.set(candidate.collectionId, group);
  }

  for (const [collectionId, candidates] of packageGroups.entries()) {
    if (
      candidates.length < MIN_DOCUMENTATION_COLLECTION_ITEMS &&
      !collections.has(collectionId)
    ) continue;

    const collection = collections.get(collectionId) ?? {
      id: collectionId,
      title: candidates[0]?.collectionTitle ?? titleize(collectionId),
      description: `Published ${titleize(collectionId).toLowerCase()} packages detected in the project.`,
      kind: "package" as const,
      sourceEvidence: [],
      items: [],
    };

    const bySlug = new Map(collection.items.map((item) => [item.slug, item]));
    for (const candidate of candidates) {
      bySlug.set(candidate.item.slug, mergeItems(bySlug.get(candidate.item.slug), candidate.item));
    }

    collections.set(collectionId, {
      ...collection,
      kind: collection.kind === "docs" ? "mixed" : collection.kind,
      items: Array.from(bySlug.values()).sort((a, b) => a.title.localeCompare(b.title)),
    });
  }
}

function removeOverlappingCollections(
  collections: DocumentationCollection[],
): DocumentationCollection[] {
  const sorted = [...collections].sort((a, b) => b.items.length - a.items.length);
  const accepted: DocumentationCollection[] = [];

  for (const collection of sorted) {
    const collectionPaths = new Set(collection.items.flatMap((item) =>
      item.sourceEvidence.map((evidence) => evidence.path)
    ));
    const collectionItemKeys = new Set(collection.items.flatMap((item) => [
      item.slug,
      slugify(item.title),
      item.packageName ? slugify(item.packageName) : "",
    ].filter(Boolean)));
    const overlapsAccepted = accepted.some((existing) => {
      const existingPaths = new Set(existing.items.flatMap((item) =>
        item.sourceEvidence.map((evidence) => evidence.path)
      ));
      const overlapCount = Array.from(collectionPaths).filter((path) => existingPaths.has(path)).length;
      const smallerSize = Math.min(collectionPaths.size, existingPaths.size);
      if (smallerSize > 0 && overlapCount / smallerSize >= 0.6) return true;

      const existingItemKeys = new Set(existing.items.flatMap((item) => [
        item.slug,
        slugify(item.title),
        item.packageName ? slugify(item.packageName) : "",
      ].filter(Boolean)));
      const itemOverlapCount = Array.from(collectionItemKeys).filter((key) => existingItemKeys.has(key)).length;
      const smallerItemSize = Math.min(collectionItemKeys.size, existingItemKeys.size);
      return smallerItemSize > 0 && itemOverlapCount / smallerItemSize >= 0.6;
    });

    if (!overlapsAccepted) accepted.push(collection);
  }

  return accepted.sort((a, b) => a.title.localeCompare(b.title));
}

export async function discoverDocumentationCollections(
  cwd: string,
): Promise<DocumentationCollection[]> {
  const collections = await discoverDocsCollections(cwd);
  mergePackageCandidates(collections, await discoverPackageCollections(cwd));

  return removeOverlappingCollections(
    Array.from(collections.values())
      .filter((collection) =>
        collection.items.length >= MIN_DOCUMENTATION_COLLECTION_ITEMS
      )
  );
}

export function mergeDocumentationCollections(
  analysis: ProjectAnalysis,
  discovered: DocumentationCollection[],
): ProjectAnalysis {
  if (discovered.length === 0) return analysis;

  const existing = new Map((analysis.documentationCollections ?? []).map((collection) => [collection.id, collection]));
  for (const collection of discovered) {
    const previous = existing.get(collection.id);
    if (!previous) {
      existing.set(collection.id, collection);
      continue;
    }

    const items = new Map(previous.items.map((item) => [item.slug, item]));
    for (const item of collection.items) {
      items.set(item.slug, mergeItems(items.get(item.slug), item));
    }

    existing.set(collection.id, {
      ...previous,
      description: previous.description || collection.description,
      kind: previous.kind === collection.kind ? previous.kind : "mixed",
      sourceEvidence: uniqueEvidence([...previous.sourceEvidence, ...collection.sourceEvidence]),
      items: Array.from(items.values()).sort((a, b) => a.title.localeCompare(b.title)),
    });
  }

  return {
    ...analysis,
    documentationCollections: removeOverlappingCollections(Array.from(existing.values())),
  };
}

export function relativeEvidenceFiles(evidence: SourceEvidence[]): string[] {
  return Array.from(new Set(evidence.map((item) => item.path).filter(Boolean)));
}

function descriptionForCollection(collection: DocumentationCollection): string {
  return collection.description ??
    `Overview and navigation for the ${collection.title.toLowerCase()} supported by this project, with links to each detailed setup guide.`;
}

function usableDescription(description: string | undefined): string | undefined {
  const trimmed = description?.trim();
  return trimmed && trimmed.length >= MIN_PAGE_DESCRIPTION_LENGTH ? trimmed : undefined;
}

function descriptionForItem(
  collection: DocumentationCollection,
  item: DocumentationCollectionItem,
  existing: DocPage | undefined,
): string {
  return usableDescription(item.description) ??
    usableDescription(existing?.description) ??
    `Install, configure, and use ${item.title} as one of the supported ${collection.title.toLowerCase()} for this project.`;
}

function pageMatchesCollection(page: DocPage, collection: DocumentationCollection): boolean {
  if (page.collectionId === collection.id) return true;
  if (page.collectionId) return false;
  const pageKey = slugify(`${page.id} ${page.title}`);
  const collectionKey = slugify(collection.title);
  if (pageKey.includes(collection.id) ||
    pageKey.includes(collectionKey) ||
    collectionKey.includes(pageKey)) {
    return true;
  }

  const ignoredTokens = new Set(["doc", "docs", "documentation", "file", "files", "guide", "guides"]);
  const semanticTokens = (value: string): Set<string> => new Set(
    slugify(value)
      .split("-")
      .map((token) => token.endsWith("s") && token.length > 3 ? token.slice(0, -1) : token)
      .filter((token) => token.length > 1 && !ignoredTokens.has(token)),
  );
  const pageTokens = semanticTokens(`${page.id} ${page.title}`);
  const collectionTokens = semanticTokens(`${collection.id} ${collection.title}`);
  const smallerSize = Math.min(pageTokens.size, collectionTokens.size);
  if (smallerSize < 2) return false;

  const overlap = Array.from(pageTokens).filter((token) => collectionTokens.has(token)).length;
  return overlap / smallerSize >= 0.8;
}

function itemIdentityKeys(
  collection: DocumentationCollection,
  item: DocumentationCollectionItem,
): string[] {
  return [item.id, slugify(`${collection.id}/${item.slug}`), item.slug, slugify(item.title)];
}

function pageIdentityKeys(page: DocPage): string[] {
  return [page.collectionItemId, slugify(page.id), slugify(page.title)].filter(
    (key): key is string => Boolean(key),
  );
}

function collectionItemsByIdentity(
  collection: DocumentationCollection,
): Map<string, DocumentationCollectionItem> {
  const itemsByIdentity = new Map<string, DocumentationCollectionItem>();
  for (const item of collection.items) {
    for (const key of itemIdentityKeys(collection, item)) {
      if (!itemsByIdentity.has(key)) itemsByIdentity.set(key, item);
    }
  }
  return itemsByIdentity;
}

/**
 * Removes the pages that the collection replaces: one page per item, from any
 * section, and the collection overview pages in the default section. The
 * planner often writes item pages under its own ids; keeping them next to the
 * injected item pages would duplicate every item title.
 */
function claimCollectionPages(
  sections: DocSection[],
  defaultSection: DocSection,
  collection: DocumentationCollection,
): ClaimedCollectionPages {
  const itemsByIdentity = collectionItemsByIdentity(collection);
  const itemPages = new Map<string, DocPage>();
  let insertionIndex: number | undefined;

  const itemForPage = (page: DocPage): DocumentationCollectionItem | undefined => {
    if (page.collectionId && page.collectionId !== collection.id) return undefined;
    return pageIdentityKeys(page)
      .map((key) => itemsByIdentity.get(key))
      .find((item) => item !== undefined && !itemPages.has(item.id));
  };

  for (const section of sections) {
    const isDefaultSection = section === defaultSection;
    section.pages = section.pages.filter((page, index) => {
      const item = itemForPage(page);
      if (item) {
        itemPages.set(item.id, page);
      } else if (!isDefaultSection || !pageMatchesCollection(page, collection)) {
        return true;
      }
      if (isDefaultSection) insertionIndex ??= index;
      return false;
    });
  }

  return { itemPages, insertionIndex: insertionIndex ?? defaultSection.pages.length };
}

function collectionPages(
  collection: DocumentationCollection,
  itemPages: ReadonlyMap<string, DocPage>,
): DocPage[] {
  return collection.items.map((item) => {
    const existing = itemPages.get(item.id);
    return {
      id: `${collection.id}/${item.slug}`,
      title: item.title,
      description: descriptionForItem(collection, item, existing),
      group: collection.title,
      collectionId: collection.id,
      collectionItemId: item.id,
      sourceEvidence: uniqueEvidence([
        ...(existing?.sourceEvidence ?? []),
        ...collection.sourceEvidence,
        ...item.sourceEvidence,
      ]),
      audience: existing?.audience,
      navVisibility: existing?.navVisibility,
      canonicalRoute: existing?.canonicalRoute,
      allowedInternalTerms: existing?.allowedInternalTerms,
      reference: existing?.reference,
    };
  });
}

export function applyCollectionsToStructure(
  structure: DocumentationStructure,
  analysis: ProjectAnalysis,
): DocumentationStructure {
  const collections = (analysis.documentationCollections ?? [])
    .filter((collection) =>
      collection.items.length >= MIN_DOCUMENTATION_COLLECTION_ITEMS
    );
  if (collections.length === 0) return structure;

  const sections = structure.sections.map((section) => ({
    ...section,
    pages: section.pages.map((page) => {
      const { subPages: _legacyChildren, ...flatPage } = page as DocPage & {
        subPages?: unknown;
      };
      return flatPage;
    }),
  }));

  const defaultSection = sections.find((section) => section.default) ?? sections[0];
  if (!defaultSection) return structure;
  for (const collection of collections) {
    const { itemPages, insertionIndex } = claimCollectionPages(sections, defaultSection, collection);
    defaultSection.pages.splice(insertionIndex, 0, ...collectionPages(collection, itemPages));
  }

  return { sections };
}
