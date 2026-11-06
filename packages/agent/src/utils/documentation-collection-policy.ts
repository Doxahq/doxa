import type { DocumentationCollection, DocumentationCollectionItem, ProjectAnalysis } from "../types";
import { detectProjectProfile } from "../doxa-agent/prompts/dynamic/profiles";
import { slugify } from "../doxa-agent/structure-utils";

export const MIN_DOCUMENTATION_COLLECTION_ITEMS = 4;

const INTERNAL_SCRIPT_TITLES = new Set([
  "dev",
  "build",
  "start",
  "lint",
  "lint:fix",
  "format",
  "format:check",
  "typecheck",
  "quality",
  "clean",
  "prepare",
  "precommit",
  "deploy",
  "deploy:vercel",
  "deploy:cloudflare",
  "build:vercel",
  "build:cloudflare",
  "build:docker",
  "start:docker",
  "generate:docs",
  "generate:docs:watch",
  "generate-content-json",
  "generate-content-json:ide",
]);

const PACKAGE_SCRIPT_TITLE_PATTERN =
  /^[a-z0-9][a-z0-9.-]*(?::[a-z0-9][a-z0-9.-]*)+$/;

export function isPackageScriptTitle(titleKey: string): boolean {
  return PACKAGE_SCRIPT_TITLE_PATTERN.test(titleKey);
}

export function isInternalScriptTitle(titleKey: string): boolean {
  return INTERNAL_SCRIPT_TITLES.has(titleKey);
}

/** A title that only names a script. The name is public only in a CLI project. */
export function looksLikeScriptTitle(titleKey: string): boolean {
  return isInternalScriptTitle(titleKey) || isPackageScriptTitle(titleKey);
}

function withoutScriptItems(collection: DocumentationCollection): DocumentationCollection {
  const items = collection.items.filter((item) => !looksLikeScriptTitle(item.title.trim().toLowerCase()));
  return items.length === collection.items.length ? collection : { ...collection, items };
}

/**
 * The collections that get one page per item. Injection, structure validation,
 * writer validation and the planner prompt all read this list, so a page that
 * one of them requires is never a page that another one refused to add.
 *
 * The analysis can list package scripts as a collection. Structure validation
 * refuses one page per script, so those items get no page.
 */
export function collectionsWithPages(analysis: ProjectAnalysis): DocumentationCollection[] {
  const scriptsArePublic = detectProjectProfile(analysis).id === "cli";
  return removeOverlappingCollections(analysis.documentationCollections ?? [])
    .map((collection) => scriptsArePublic ? collection : withoutScriptItems(collection))
    .filter((collection) => discoveredItemCount(collection) >= MIN_DOCUMENTATION_COLLECTION_ITEMS);
}

/** The items a collection has, with the ones that the project instructions turned off. */
function discoveredItemCount(collection: DocumentationCollection): number {
  return collection.items.length + (collection.turnedOffItemCount ?? 0);
}

/**
 * One item per slug and per title, each with its own id. Injection gives every
 * item a page, so two items for one thing would give two pages with one title.
 * The model sometimes repeats an item id (or copies the template's); the later
 * item then gets the canonical `collection/slug` id.
 */
function withUniqueItems(collection: DocumentationCollection): DocumentationCollection {
  const ids = new Set<string>();
  const slugs = new Set<string>();
  const titles = new Set<string>();
  const items: DocumentationCollectionItem[] = [];
  let changed = false;

  for (const item of collection.items) {
    const titleKey = slugify(item.title);
    const id = ids.has(item.id) ? `${collection.id}/${item.slug}` : item.id;
    if (slugs.has(item.slug) || titles.has(titleKey) || ids.has(id)) {
      changed = true;
      continue;
    }
    ids.add(id);
    slugs.add(item.slug);
    titles.add(titleKey);
    changed ||= id !== item.id;
    items.push(id === item.id ? item : { ...item, id });
  }

  return changed ? { ...collection, items } : collection;
}

function collectionItemKeys(collection: DocumentationCollection): Set<string> {
  return new Set(collection.items.flatMap((item) => [
    item.slug,
    slugify(item.title),
    item.packageName ? slugify(item.packageName) : "",
  ].filter(Boolean)));
}

function collectionEvidencePaths(collection: DocumentationCollection): Set<string> {
  return new Set(collection.items.flatMap((item) =>
    item.sourceEvidence.map((evidence) => evidence.path)
  ));
}

function overlapRatio(a: Set<string>, b: Set<string>): number {
  const smallerSize = Math.min(a.size, b.size);
  if (smallerSize === 0) return 0;
  return Array.from(a).filter((key) => b.has(key)).length / smallerSize;
}

/**
 * Evidence paths identify items only when the items come from many files, as
 * in a docs folder. Two collections that the model reads from one source file
 * (two enums in types.ts) share their paths and still list different items.
 */
function evidencePathOverlap(a: Set<string>, b: Set<string>): number {
  if (Math.min(a.size, b.size) < MIN_DOCUMENTATION_COLLECTION_ITEMS) return 0;
  return overlapRatio(a, b);
}

/**
 * Keeps one collection per group of overlapping collections, the largest. A
 * collection that overlaps less still loses the items whose titles an accepted
 * collection already has: injection gives every item a page, and two pages
 * with one title fail structure validation.
 */
export function removeOverlappingCollections(
  collections: DocumentationCollection[],
): DocumentationCollection[] {
  const sorted = collections.map(withUniqueItems).sort((a, b) => b.items.length - a.items.length);
  const accepted: DocumentationCollection[] = [];
  const acceptedItemTitles = new Set<string>();

  for (const collection of sorted) {
    const paths = collectionEvidencePaths(collection);
    const itemKeys = collectionItemKeys(collection);
    const overlapsAccepted = accepted.some((existing) =>
      evidencePathOverlap(paths, collectionEvidencePaths(existing)) >= 0.6 ||
      overlapRatio(itemKeys, collectionItemKeys(existing)) >= 0.6
    );
    if (overlapsAccepted) continue;

    const items = collection.items.filter((item) => !acceptedItemTitles.has(slugify(item.title)));
    if (items.length === 0) continue;
    for (const item of items) acceptedItemTitles.add(slugify(item.title));
    accepted.push(items.length === collection.items.length ? collection : { ...collection, items });
  }

  return accepted.sort((a, b) => a.title.localeCompare(b.title));
}
