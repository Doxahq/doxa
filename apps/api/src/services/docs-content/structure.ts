import {
  DOCS_PAGE_SLUG_PATTERN,
  DOCS_SECTION_SLUG_PATTERN,
  type DocsContentEdit,
} from "@doxahq/contracts";
import {
  normalizeHref,
  sourcePathForHref,
  type DocsManifest,
} from "@doxahq/docs-engine";

import { DocsContentError } from "./errors";

export interface ContentStructurePage {
  title: string;
  href: string;
  sourcePath: string;
}

export interface ContentStructureSection {
  slug: string;
  label: string;
  default: boolean;
  /** Renderer fields that structure editing does not own. */
  attributes: Record<string, unknown>;
  /** Navigation nodes, including fields that the editor does not model. */
  nodes: unknown[];
}

/** The complete editable arrangement of one documentation site. */
export interface ContentStructure {
  pages: ContentStructurePage[];
  sections: ContentStructureSection[];
}

export type StructureBodyWrite =
  | { type: "create"; href: string; content: string }
  | { type: "copy"; fromHref: string; toHref: string; title: string }
  /** Drops the working body of a deleted page, so a later page cannot inherit it. */
  | { type: "remove"; href: string };

export interface StructureEditResult {
  structure: ContentStructure;
  bodyWrites: StructureBodyWrite[];
}

export interface ContentStructureArtifacts {
  manifest: DocsManifest;
  sectionsArtifact: unknown[];
  documentsBySection: Map<string, unknown[]>;
}

interface NodeLocation {
  section: ContentStructureSection;
  parent: unknown[];
  index: number;
  node: Record<string, unknown>;
}

interface HeadingLocation extends NodeLocation {
  groupIndex: number;
}

interface InsertionAnchor {
  parent: unknown[];
  beforeNode: Record<string, unknown> | null;
}

interface HrefChange {
  fromHref: string;
  toHref: string;
  title: string;
}

const DEFAULT_SECTION_SLUG = "default";
const DEFAULT_PAGE_TITLE = "New Page";
const DEFAULT_PAGE_SLUG = "new-page";

/** Converts parsed runtime artifacts into the pure structure-editing model. */
export function contentStructureFromArtifacts(
  manifest: DocsManifest,
  sectionsArtifact: readonly unknown[],
  documentsBySection: ReadonlyMap<string, unknown[]>,
): ContentStructure {
  const sections = sectionsArtifact.map((value) => {
    if (!isRecord(value))
      invalid("The section list contains an invalid entry.");
    const slug = typeof value.slug === "string" ? value.slug.trim() : "";
    const label = typeof value.label === "string" ? value.label.trim() : "";
    if (!slug || !label) invalid("Every section must have a slug and a label.");
    const attributes = Object.fromEntries(
      Object.entries(value).filter(
        ([key]) => key !== "slug" && key !== "label" && key !== "default",
      ),
    );
    return {
      slug,
      label,
      default: value.default === true,
      attributes,
      nodes: flattenNavigationNodes(documentsBySection.get(slug) ?? []),
    } satisfies ContentStructureSection;
  });
  const structure = {
    pages: manifest.pages.map((page) => ({ ...page })),
    sections,
  } satisfies ContentStructure;
  validateStructure(structure);
  return structure;
}

/** Converts the pure model back into full-replacement working artifacts. */
export function contentStructureToArtifacts(
  structure: ContentStructure,
  baseManifest: DocsManifest,
): ContentStructureArtifacts {
  validateStructure(structure);
  return {
    manifest: {
      ...baseManifest,
      pages: structure.pages.map((page) => ({ ...page })),
    },
    sectionsArtifact: structure.sections.map((section) => ({
      ...section.attributes,
      slug: section.slug,
      label: section.label,
      ...(section.default ? { default: true } : {}),
    })),
    documentsBySection: new Map(
      structure.sections.map((section) => [
        section.slug,
        cloneNodes(section.nodes),
      ]),
    ),
  };
}

/** Applies one validated structure edit without store access or other IO. */
export function applyStructureEdit(
  structure: ContentStructure,
  edit: Exclude<
    DocsContentEdit,
    { type: "set_site_config" | "reset_site_config" | "set_home_page" }
  >,
): StructureEditResult {
  const next = cloneStructure(structure);
  let bodyWrites: StructureBodyWrite[] = [];

  switch (edit.type) {
    case "set_page_content":
    case "reset_page":
      return { structure: next, bodyWrites };
    case "create_section":
      bodyWrites = createSection(next, edit.slug, edit.label);
      break;
    case "rename_section":
      renameSection(next, edit.slug, edit.label);
      break;
    case "create_group":
      bodyWrites = createGroup(
        next,
        edit.sectionSlug,
        edit.heading,
        edit.starterPage === true,
      );
      break;
    case "rename_group":
      renameGroup(next, edit.sectionSlug, edit.groupIndex, edit.heading);
      break;
    case "create_page":
      bodyWrites = createPage(
        next,
        edit.sectionSlug,
        edit.groupIndex,
        edit.title,
        edit.slug,
      );
      break;
    case "rename_page":
      bodyWrites = renamePage(next, edit.href, edit.title, edit.slug);
      break;
    case "set_page_icon":
      setPageIcon(next, edit.href, edit.icon);
      break;
    case "move_section":
      moveSection(next, edit.slug, edit.beforeSlug);
      break;
    case "move_group":
      bodyWrites = moveGroup(
        next,
        edit.sectionSlug,
        edit.groupIndex,
        edit.toSectionSlug,
        edit.beforeGroupIndex,
      );
      break;
    case "move_page":
      bodyWrites = movePage(
        next,
        edit.href,
        edit.toSectionSlug,
        edit.toGroupIndex,
        edit.beforeHref,
      );
      break;
    case "delete_section":
      bodyWrites = deleteSection(next, edit.slug);
      break;
    case "delete_group":
      bodyWrites = deleteGroup(next, edit.sectionSlug, edit.groupIndex);
      break;
    case "delete_page":
      bodyWrites = deletePage(next, edit.href);
      break;
  }

  validateStructure(next);
  return { structure: next, bodyWrites };
}

/**
 * Puts a page of `source` back into `target` where `source` has it: in the
 * same section and group, between the same neighbors, so restoring pages one
 * by one, in any order, rebuilds the source order. A missing section or
 * heading comes back with it. The caller restores the page body.
 */
export function restoreStructurePage(
  target: ContentStructure,
  source: ContentStructure,
  href: string,
): ContentStructure {
  const normalizedHref = normalizeHref(href);
  const next = cloneStructure(target);
  if (next.pages.some((page) => normalizeHref(page.href) === normalizedHref)) {
    return next;
  }

  const page = requireManifestPage(source, normalizedHref);
  const location = requirePageLocation(source, normalizedHref);
  const heading = headingAbove(location.parent, location.index);
  const section = ensureRestoredSection(next, source, location.section);
  insertAtSourcePosition(section, location.parent, location.index, heading, cloneValue(location.node));
  next.pages.push({ ...page });
  validateStructure(next);
  return next;
}

/** Sets the title of one page in the manifest and in its navigation entry. */
export function setStructurePageTitle(
  structure: ContentStructure,
  href: string,
  title: string,
): ContentStructure {
  const next = cloneStructure(structure);
  requireManifestPage(next, href).title = title;
  const location = requirePageLocation(next, normalizeHref(href));
  if (typeof location.node.title === "string") location.node.title = title;
  return next;
}

/**
 * The section of `structure` that receives a restored page. A page of the
 * default section keeps an href without a section prefix, so it always goes
 * to the default section of `structure`.
 */
function ensureRestoredSection(
  structure: ContentStructure,
  source: ContentStructure,
  sourceSection: ContentStructureSection,
): ContentStructureSection {
  if (sourceSection.default) {
    const defaultSection = structure.sections.find((section) => section.default);
    if (!defaultSection) invalid("The documentation has no default section.");
    return defaultSection;
  }

  const existing = structure.sections.find(
    (section) => section.slug === sourceSection.slug,
  );
  if (existing) return existing;

  const restored: ContentStructureSection = {
    slug: sourceSection.slug,
    label: sourceSection.label,
    default: false,
    attributes: { ...sourceSection.attributes },
    nodes: [],
  };
  const sourceIndex = source.sections.indexOf(sourceSection);
  const precedingIndex = source.sections
    .slice(0, sourceIndex)
    .map((section) =>
      structure.sections.findIndex((candidate) => candidate.slug === section.slug),
    )
    .filter((index) => index >= 0)
    .at(-1);
  structure.sections.splice(
    precedingIndex === undefined ? structure.sections.length : precedingIndex + 1,
    0,
    restored,
  );
  return restored;
}

/**
 * Inserts a page node at the end of the group under `heading`, or among the
 * ungrouped pages at the top of the section when `heading` is null.
 */
/**
 * Inserts a restored page node where the source navigation has it: right
 * after the nearest page before it in its source group that the section
 * still holds in that group, else right before the nearest such page after
 * it. A group that holds none of those pages gets the node at its end, and a
 * missing heading comes back with it (see `insertGroup`).
 */
function insertAtSourcePosition(
  section: ContentStructureSection,
  sourceNodes: readonly unknown[],
  sourceIndex: number,
  heading: Record<string, unknown> | null,
  node: unknown,
): void {
  const headingText = heading === null ? null : heading.heading;
  const groupStart = heading === null ? 0 : sourceNodes.indexOf(heading) + 1;
  const groupEnd = nextHeadingIndex(sourceNodes, sourceIndex + 1);
  const inGroup = (href: string): number => {
    const index = section.nodes.findIndex(
      (candidate) => isRecord(candidate) && typeof candidate.href === "string" && normalizeHref(candidate.href) === href,
    );
    return index >= 0 && (headingAbove(section.nodes, index)?.heading ?? null) === headingText ? index : -1;
  };

  for (const href of pageHrefs(sourceNodes.slice(groupStart, sourceIndex)).reverse()) {
    const index = inGroup(href);
    if (index >= 0) {
      section.nodes.splice(index + 1, 0, node);
      return;
    }
  }
  for (const href of pageHrefs(sourceNodes.slice(sourceIndex + 1, groupEnd))) {
    const index = inGroup(href);
    if (index >= 0) {
      section.nodes.splice(index, 0, node);
      return;
    }
  }

  if (heading === null) {
    section.nodes.splice(nextHeadingIndex(section.nodes, 0), 0, node);
    return;
  }
  const headingIndex = section.nodes.findIndex(
    (candidate) => isHeadingNode(candidate) && candidate.heading === headingText,
  );
  if (headingIndex >= 0) {
    section.nodes.splice(nextHeadingIndex(section.nodes, headingIndex + 1), 0, node);
    return;
  }
  insertGroup(section, sourceNodes, heading, node);
}

/**
 * Brings back a heading with its first page, between the groups that
 * surround it in the source navigation: after the group of the nearest
 * source heading before it that the section has, else before the nearest
 * such heading after it, else at the end of the section.
 */
function insertGroup(
  section: ContentStructureSection,
  sourceNodes: readonly unknown[],
  heading: Record<string, unknown>,
  node: unknown,
): void {
  const restored = [cloneValue(heading), node];
  const sourceHeadingIndex = sourceNodes.indexOf(heading);
  const headingIndexOf = (text: unknown): number =>
    section.nodes.findIndex((candidate) => isHeadingNode(candidate) && candidate.heading === text);
  const sourceHeadings = (from: number, to: number) =>
    sourceNodes.slice(from, to).filter(isHeadingNode).map((candidate) => candidate.heading);

  for (const text of sourceHeadings(0, sourceHeadingIndex).reverse()) {
    const index = headingIndexOf(text);
    if (index >= 0) {
      section.nodes.splice(nextHeadingIndex(section.nodes, index + 1), 0, ...restored);
      return;
    }
  }
  for (const text of sourceHeadings(sourceHeadingIndex + 1, sourceNodes.length)) {
    const index = headingIndexOf(text);
    if (index >= 0) {
      section.nodes.splice(index, 0, ...restored);
      return;
    }
  }
  section.nodes.push(...restored);
}

function createSection(
  structure: ContentStructure,
  slug: string,
  label: string,
): StructureBodyWrite[] {
  validateSectionSlug(slug);
  if (structure.sections.some((section) => section.slug === slug)) {
    invalid(`A section already uses the slug ${slug}.`);
  }
  const conflictingPage = structure.pages.find((page) => {
    const section = findPageSection(structure, page.href);
    return section?.default === true && firstPathSegment(page.href) === slug;
  });
  if (conflictingPage) {
    invalid(`The section slug ${slug} conflicts with an existing page path.`);
  }

  const href = `/${slug}`;
  assertHrefAvailable(structure, href);
  structure.sections.push({
    slug,
    label,
    default: false,
    attributes: {},
    nodes: [{ title: DEFAULT_PAGE_TITLE, href }],
  });
  structure.pages.push(createManifestPage(DEFAULT_PAGE_TITLE, href));
  return [
    { type: "create", href, content: createBlankPageBody(DEFAULT_PAGE_TITLE) },
  ];
}

function renameSection(
  structure: ContentStructure,
  slug: string,
  label: string,
): void {
  const section = requireSection(structure, slug);
  section.label = label;
}

/**
 * Adds a heading at the end of a section. The group starts empty unless the
 * caller asks for a starter page, which the dashboard opens right away.
 */
function createGroup(
  structure: ContentStructure,
  sectionSlug: string,
  heading: string,
  withStarterPage: boolean,
): StructureBodyWrite[] {
  const section = requireSection(structure, sectionSlug);
  section.nodes.push({ heading });
  if (!withStarterPage) return [];

  const href = buildPageHref(section, uniquePageSlug(structure, section));
  section.nodes.push({ title: DEFAULT_PAGE_TITLE, href });
  structure.pages.push(createManifestPage(DEFAULT_PAGE_TITLE, href));
  return [
    { type: "create", href, content: createBlankPageBody(DEFAULT_PAGE_TITLE) },
  ];
}

function renameGroup(
  structure: ContentStructure,
  sectionSlug: string,
  groupIndex: number,
  heading: string,
): void {
  const section = requireSection(structure, sectionSlug);
  const location = requireHeading(section, groupIndex);
  location.node.heading = heading;
}

function createPage(
  structure: ContentStructure,
  sectionSlug: string,
  groupIndex: number | null,
  title: string,
  slug: string,
): StructureBodyWrite[] {
  validatePageSlug(slug);
  const section = requireSection(structure, sectionSlug);
  const href = buildPageHref(section, slug);
  assertHrefAvailable(structure, href);
  const anchor = resolveInsertionAnchor(section, groupIndex, null);
  insertAtAnchor(anchor, [{ title, href }]);
  structure.pages.push(createManifestPage(title, href));
  return [{ type: "create", href, content: createBlankPageBody(title) }];
}

function renamePage(
  structure: ContentStructure,
  href: string,
  title: string,
  slug: string,
): StructureBodyWrite[] {
  validatePageSlug(slug);
  const normalizedHref = normalizeHref(href);
  const page = requireManifestPage(structure, normalizedHref);
  const sourceSection = requirePageSection(structure, normalizedHref);
  const nextHref = buildPageHref(sourceSection, slug);
  if (nextHref !== normalizedHref) assertHrefAvailable(structure, nextHref);

  rewritePage(structure, normalizedHref, nextHref, title);
  page.title = title;
  return [
    {
      type: "copy",
      fromHref: normalizedHref,
      toHref: nextHref,
      title,
    },
  ];
}

/**
 * Sets or removes the icon of every navigation entry for one page. The icon
 * lives in the navigation artifact, where the renderer reads it.
 */
function setPageIcon(
  structure: ContentStructure,
  href: string,
  icon: string | null,
): void {
  const normalizedHref = normalizeHref(href);
  requireManifestPage(structure, normalizedHref);
  let found = false;
  const visit = (nodes: unknown[]) => {
    for (const node of nodes) {
      if (!isRecord(node)) continue;
      if (typeof node.href === "string" && normalizeHref(node.href) === normalizedHref) {
        found = true;
        if (icon === null) delete node.icon;
        else node.icon = icon;
      }
      if (Array.isArray(node.items)) visit(node.items);
    }
  };
  for (const section of structure.sections) visit(section.nodes);
  if (!found) invalid(`No navigation entry exists for the page at ${normalizedHref}.`);
}

/**
 * Deletes one section with everything inside it.
 *
 * The renderer requires exactly one section marked default, and that section
 * owns the root of the site. Deleting it would leave the documentation with no
 * landing page, so it is refused.
 */
function deleteSection(
  structure: ContentStructure,
  slug: string,
): StructureBodyWrite[] {
  const section = requireSection(structure, slug);
  if (section.default) {
    invalid(
      "The default section holds the start of the documentation and cannot be deleted.",
    );
  }

  const hrefs = pageHrefs(section.nodes);
  structure.sections = structure.sections.filter(
    (candidate) => candidate !== section,
  );
  removePages(structure, hrefs);
  assertDocumentationNotEmpty(structure);
  return hrefs.map(toBodyRemove);
}

/** Deletes one group with every page it holds. */
function deleteGroup(
  structure: ContentStructure,
  sectionSlug: string,
  groupIndex: number,
): StructureBodyWrite[] {
  const section = requireSection(structure, sectionSlug);
  const heading = requireHeading(section, groupIndex);
  const endIndex = nextHeadingIndex(heading.parent, heading.index + 1);
  const removedNodes = heading.parent.slice(heading.index, endIndex);
  const hrefs = pageHrefs(removedNodes);

  heading.parent.splice(heading.index, removedNodes.length);
  removePages(structure, hrefs);
  dropSectionIfEmpty(structure, section);
  assertDocumentationNotEmpty(structure);
  return hrefs.map(toBodyRemove);
}

/** Deletes one page, and the group or section it leaves empty. */
function deletePage(
  structure: ContentStructure,
  href: string,
): StructureBodyWrite[] {
  const location = requirePageLocation(structure, normalizeHref(href));
  const deletedHref = normalizeHref(href);
  const owningHeading = headingAbove(location.parent, location.index);

  location.parent.splice(location.index, 1);
  removePages(structure, [deletedHref]);
  if (owningHeading) dropHeadingIfEmpty(location.parent, owningHeading);
  dropSectionIfEmpty(structure, location.section);
  assertDocumentationNotEmpty(structure);
  return [toBodyRemove(deletedHref)];
}

function removePages(
  structure: ContentStructure,
  hrefs: readonly string[],
): void {
  const removed = new Set(hrefs.map(normalizeHref));
  structure.pages = structure.pages.filter(
    (page) => !removed.has(normalizeHref(page.href)),
  );
}

/**
 * Containers that a delete leaves empty are dropped, so the delete takes them
 * with it. An empty group renders a heading with nothing under it, and an
 * empty section renders a tab that opens on nothing. Only the group and the
 * section that held the deleted node are checked: an empty group elsewhere,
 * such as one `create_group` just added, stays until a page fills it.
 */
function headingAbove(
  nodes: readonly unknown[],
  index: number,
): Record<string, unknown> | null {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const node = nodes[cursor];
    if (isHeadingNode(node)) return node;
  }
  return null;
}

function dropHeadingIfEmpty(
  nodes: unknown[],
  heading: Record<string, unknown>,
): void {
  const index = nodes.indexOf(heading);
  if (index < 0) return;
  const endIndex = nextHeadingIndex(nodes, index + 1);
  if (pageHrefs(nodes.slice(index + 1, endIndex)).length === 0) {
    nodes.splice(index, endIndex - index);
  }
}

/** The default section is never dropped, because the documentation always has one. */
function dropSectionIfEmpty(
  structure: ContentStructure,
  section: ContentStructureSection,
): void {
  if (section.default || pageHrefs(section.nodes).length > 0) return;
  structure.sections = structure.sections.filter(
    (candidate) => candidate !== section,
  );
}

/** The documentation must keep at least one page, or the renderer has nothing to serve. */
function assertDocumentationNotEmpty(structure: ContentStructure): void {
  if (structure.pages.length === 0) {
    invalid("The documentation must keep at least one page.");
  }
}

function toBodyRemove(href: string): StructureBodyWrite {
  return { type: "remove", href: normalizeHref(href) };
}

function moveSection(
  structure: ContentStructure,
  slug: string,
  beforeSlug: string | null,
): void {
  const sourceIndex = structure.sections.findIndex(
    (section) => section.slug === slug,
  );
  if (sourceIndex < 0) invalid(`No section exists with the slug ${slug}.`);
  if (beforeSlug === slug) return;
  if (
    beforeSlug !== null &&
    !structure.sections.some((section) => section.slug === beforeSlug)
  ) {
    invalid(`No section exists with the slug ${beforeSlug}.`);
  }

  const [section] = structure.sections.splice(sourceIndex, 1);
  if (!section) invalid(`No section exists with the slug ${slug}.`);
  const insertionIndex =
    beforeSlug === null
      ? structure.sections.length
      : structure.sections.findIndex(
          (candidate) => candidate.slug === beforeSlug,
        );
  structure.sections.splice(insertionIndex, 0, section);
}

function moveGroup(
  structure: ContentStructure,
  sectionSlug: string,
  groupIndex: number,
  targetSectionSlug: string,
  beforeGroupIndex: number | null,
): StructureBodyWrite[] {
  const sourceSection = requireSection(structure, sectionSlug);
  const targetSection = requireSection(structure, targetSectionSlug);
  const source = requireHeading(sourceSection, groupIndex);
  if (
    sourceSection === targetSection &&
    beforeGroupIndex !== null &&
    beforeGroupIndex === groupIndex
  ) {
    return [];
  }
  const targetHeading =
    beforeGroupIndex === null
      ? null
      : requireHeading(targetSection, beforeGroupIndex);
  const endIndex = nextHeadingIndex(source.parent, source.index + 1);
  const movedNodes = source.parent.slice(source.index, endIndex);
  const hrefs = pageHrefs(movedNodes);
  const changes =
    sourceSection === targetSection
      ? []
      : buildHrefChanges(structure, hrefs, sourceSection, targetSection);
  assertHrefChangesAvailable(structure, changes);

  source.parent.splice(source.index, movedNodes.length);
  const insertionParent = targetHeading?.parent ?? targetSection.nodes;
  const insertionIndex = targetHeading
    ? insertionParent.indexOf(targetHeading.node)
    : insertionParent.length;
  if (targetHeading && insertionIndex < 0) {
    invalid("The target group moved with the source group.");
  }
  insertionParent.splice(insertionIndex, 0, ...movedNodes);
  for (const change of changes) {
    rewritePage(structure, change.fromHref, change.toHref, change.title);
  }
  return changes.map(toBodyCopy);
}

function movePage(
  structure: ContentStructure,
  href: string,
  targetSectionSlug: string,
  targetGroupIndex: number | null,
  beforeHref: string | null,
): StructureBodyWrite[] {
  const normalizedHref = normalizeHref(href);
  const source = requirePageLocation(structure, normalizedHref);
  const targetSection = requireSection(structure, targetSectionSlug);
  const anchor = resolveInsertionAnchor(
    targetSection,
    targetGroupIndex,
    beforeHref,
  );
  if (anchor.beforeNode === source.node) return [];

  const movedHrefs = pageHrefs([source.node]);
  const changes =
    source.section === targetSection
      ? []
      : buildHrefChanges(structure, movedHrefs, source.section, targetSection);
  assertHrefChangesAvailable(structure, changes);

  source.parent.splice(source.index, 1);
  insertAtAnchor(anchor, [source.node]);
  for (const change of changes) {
    rewritePage(structure, change.fromHref, change.toHref, change.title);
  }
  return changes.map(toBodyCopy);
}

function resolveInsertionAnchor(
  section: ContentStructureSection,
  groupIndex: number | null,
  beforeHref: string | null,
): InsertionAnchor {
  if (beforeHref) {
    const target = findPageLocationInSection(
      section,
      normalizeHref(beforeHref),
    );
    if (!target)
      invalid(`No target page exists at ${normalizeHref(beforeHref)}.`);
    const targetGroupIndex = groupIndexForNode(section, target.node);
    if (targetGroupIndex !== groupIndex) {
      invalid("The target page is not inside the selected group.");
    }
    return { parent: target.parent, beforeNode: target.node };
  }

  if (groupIndex === null) {
    const firstHeading = section.nodes.find(isHeadingNode) ?? null;
    return { parent: section.nodes, beforeNode: firstHeading };
  }

  const heading = requireHeading(section, groupIndex);
  const boundary =
    heading.parent.slice(heading.index + 1).find(isHeadingNode) ?? null;
  return { parent: heading.parent, beforeNode: boundary };
}

function insertAtAnchor(anchor: InsertionAnchor, nodes: unknown[]): void {
  const index =
    anchor.beforeNode === null
      ? anchor.parent.length
      : anchor.parent.indexOf(anchor.beforeNode);
  if (index < 0) invalid("The selected drop target is no longer available.");
  anchor.parent.splice(index, 0, ...nodes);
}

function buildHrefChanges(
  structure: ContentStructure,
  hrefs: readonly string[],
  sourceSection: ContentStructureSection,
  targetSection: ContentStructureSection,
): HrefChange[] {
  return hrefs.map((href) => {
    const page = requireManifestPage(structure, href);
    return {
      fromHref: href,
      toHref: buildPageHref(
        targetSection,
        pageSlugInsideSection(href, sourceSection),
      ),
      title: page.title,
    };
  });
}

function rewritePage(
  structure: ContentStructure,
  oldHref: string,
  newHref: string,
  title: string,
): void {
  const page = requireManifestPage(structure, oldHref);
  page.href = newHref;
  page.title = title;
  page.sourcePath = sourcePathForHref(newHref);
  for (const section of structure.sections) {
    rewriteNavigationNodes(section.nodes, oldHref, newHref, title);
  }
}

function rewriteNavigationNodes(
  nodes: unknown[],
  oldHref: string,
  newHref: string,
  title: string,
): void {
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    if (typeof node.href === "string" && normalizeHref(node.href) === oldHref) {
      node.href = newHref;
      node.title = title;
    }
    if (Array.isArray(node.items))
      rewriteNavigationNodes(node.items, oldHref, newHref, title);
  }
}

function assertHrefChangesAvailable(
  structure: ContentStructure,
  changes: readonly HrefChange[],
): void {
  const movedHrefs = new Set(changes.map((change) => change.fromHref));
  const nextHrefs = new Set<string>();
  for (const change of changes) {
    if (nextHrefs.has(change.toHref))
      invalid(`A page already exists at ${change.toHref}.`);
    nextHrefs.add(change.toHref);
    const conflict = structure.pages.some(
      (page) => page.href === change.toHref && !movedHrefs.has(page.href),
    );
    if (conflict) invalid(`A page already exists at ${change.toHref}.`);
  }
}

function requireSection(
  structure: ContentStructure,
  slug: string,
): ContentStructureSection {
  const section = structure.sections.find(
    (candidate) => candidate.slug === slug,
  );
  if (!section) invalid(`No section exists with the slug ${slug}.`);
  return section;
}

function requireManifestPage(
  structure: ContentStructure,
  href: string,
): ContentStructurePage {
  const normalizedHref = normalizeHref(href);
  const page = structure.pages.find(
    (candidate) => normalizeHref(candidate.href) === normalizedHref,
  );
  if (!page) invalid(`No page exists at ${normalizedHref}.`);
  return page;
}

function requirePageSection(
  structure: ContentStructure,
  href: string,
): ContentStructureSection {
  const section = findPageSection(structure, href);
  if (!section) invalid(`No navigation entry exists for the page at ${href}.`);
  return section;
}

function findPageSection(
  structure: ContentStructure,
  href: string,
): ContentStructureSection | null {
  return (
    structure.sections.find(
      (section) =>
        findPageLocationInSection(section, normalizeHref(href)) !== null,
    ) ?? null
  );
}

function requirePageLocation(
  structure: ContentStructure,
  href: string,
): NodeLocation {
  for (const section of structure.sections) {
    const location = findPageLocationInSection(section, href);
    if (location) return location;
  }
  invalid(`No navigation entry exists for the page at ${href}.`);
}

function findPageLocationInSection(
  section: ContentStructureSection,
  href: string,
): NodeLocation | null {
  return findNodeLocation(
    section,
    section.nodes,
    (node) =>
      typeof node.href === "string" && normalizeHref(node.href) === href,
  );
}

function findNodeLocation(
  section: ContentStructureSection,
  nodes: unknown[],
  matches: (node: Record<string, unknown>) => boolean,
): NodeLocation | null {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!isRecord(node)) continue;
    if (matches(node)) return { section, parent: nodes, index, node };
    if (Array.isArray(node.items)) {
      const nested = findNodeLocation(section, node.items, matches);
      if (nested) return nested;
    }
  }
  return null;
}

function requireHeading(
  section: ContentStructureSection,
  groupIndex: number,
): HeadingLocation {
  let currentIndex = 0;
  let found: HeadingLocation | null = null;

  const visit = (nodes: unknown[]): void => {
    for (let index = 0; index < nodes.length && !found; index += 1) {
      const node = nodes[index];
      if (!isRecord(node)) continue;
      if (isHeadingNode(node)) {
        if (currentIndex === groupIndex) {
          found = { section, parent: nodes, index, node, groupIndex };
          return;
        }
        currentIndex += 1;
      }
      if (Array.isArray(node.items)) visit(node.items);
    }
  };
  visit(section.nodes);
  if (!found)
    invalid(
      `No group exists at index ${groupIndex} in section ${section.slug}.`,
    );
  return found;
}

function groupIndexForNode(
  section: ContentStructureSection,
  target: Record<string, unknown>,
): number | null {
  let nextGroupIndex = 0;
  let activeGroupIndex: number | null = null;
  let result: number | null | undefined;

  const visit = (
    nodes: unknown[],
    inheritedGroupIndex: number | null,
  ): void => {
    let groupIndex = inheritedGroupIndex;
    for (const value of nodes) {
      if (result !== undefined || !isRecord(value)) continue;
      if (isHeadingNode(value)) {
        groupIndex = nextGroupIndex;
        nextGroupIndex += 1;
      }
      if (value === target) {
        result = groupIndex;
        return;
      }
      if (Array.isArray(value.items)) visit(value.items, groupIndex);
    }
  };
  visit(section.nodes, activeGroupIndex);
  return result ?? null;
}

function nextHeadingIndex(nodes: readonly unknown[], start: number): number {
  for (let index = start; index < nodes.length; index += 1) {
    if (isHeadingNode(nodes[index])) return index;
  }
  return nodes.length;
}

function pageHrefs(nodes: readonly unknown[]): string[] {
  const hrefs: string[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    if (typeof node.href === "string") hrefs.push(normalizeHref(node.href));
    if (Array.isArray(node.items)) hrefs.push(...pageHrefs(node.items));
  }
  return hrefs;
}

function buildPageHref(section: ContentStructureSection, slug: string): string {
  const cleanSlug = slug.replace(/^\/+|\/+$/g, "");
  if (section.default) return cleanSlug ? `/${cleanSlug}` : "/";
  return cleanSlug ? `/${section.slug}/${cleanSlug}` : `/${section.slug}`;
}

function pageSlugInsideSection(
  href: string,
  section: ContentStructureSection,
): string {
  const normalizedHref = normalizeHref(href);
  if (section.default) return normalizedHref.replace(/^\//, "");
  const prefix = `/${section.slug}`;
  if (normalizedHref === prefix) return "";
  if (!normalizedHref.startsWith(`${prefix}/`)) {
    invalid(
      `The page at ${normalizedHref} does not belong to section ${section.slug}.`,
    );
  }
  return normalizedHref.slice(prefix.length + 1);
}

function uniquePageSlug(
  structure: ContentStructure,
  section: ContentStructureSection,
): string {
  let suffix = 1;
  while (true) {
    const slug =
      suffix === 1 ? DEFAULT_PAGE_SLUG : `${DEFAULT_PAGE_SLUG}-${suffix}`;
    const href = buildPageHref(section, slug);
    if (!structure.pages.some((page) => normalizeHref(page.href) === href))
      return slug;
    suffix += 1;
  }
}

function createManifestPage(title: string, href: string): ContentStructurePage {
  return { title, href, sourcePath: sourcePathForHref(href) };
}

function createBlankPageBody(title: string): string {
  return `---\ntitle: ${title}\ndescription: \"\"\n---\n\nNew Page!\n`;
}

function validateStructure(structure: ContentStructure): void {
  const slugs = new Set<string>();
  let defaultCount = 0;
  for (const section of structure.sections) {
    validateSectionSlug(section.slug);
    if (!section.label.trim()) invalid("Every section must have a label.");
    if (slugs.has(section.slug))
      invalid(`The section slug ${section.slug} is duplicated.`);
    slugs.add(section.slug);
    if (section.default) defaultCount += 1;
    if (
      section.nodes.some((node) => isRecord(node) && Array.isArray(node.items))
    ) {
      invalid("Pages cannot contain other pages. Use a section group instead.");
    }
  }
  if (defaultCount !== 1)
    invalid("The documentation must have exactly one default section.");

  const hrefs = new Set<string>();
  for (const page of structure.pages) {
    const href = normalizeHref(page.href);
    if (hrefs.has(href)) invalid(`A page already exists at ${href}.`);
    hrefs.add(href);
  }
}

function validateSectionSlug(slug: string): void {
  if (!DOCS_SECTION_SLUG_PATTERN.test(slug))
    invalid(`The section slug ${slug} is invalid.`);
}

function validatePageSlug(slug: string): void {
  if (!DOCS_PAGE_SLUG_PATTERN.test(slug))
    invalid(`The page slug ${slug} is invalid.`);
}

function assertHrefAvailable(structure: ContentStructure, href: string): void {
  const normalizedHref = normalizeHref(href);
  if (
    structure.pages.some((page) => normalizeHref(page.href) === normalizedHref)
  ) {
    invalid(`A page already exists at ${normalizedHref}.`);
  }
}

function firstPathSegment(href: string): string | null {
  return normalizeHref(href).split("/").filter(Boolean)[0] ?? null;
}

function toBodyCopy(change: HrefChange): StructureBodyWrite {
  return {
    type: "copy",
    fromHref: change.fromHref,
    toHref: change.toHref,
    title: change.title,
  };
}

function cloneStructure(structure: ContentStructure): ContentStructure {
  return {
    pages: structure.pages.map((page) => ({ ...page })),
    sections: structure.sections.map((section) => ({
      ...section,
      attributes: { ...section.attributes },
      nodes: flattenNavigationNodes(section.nodes),
    })),
  };
}

function cloneNodes(nodes: readonly unknown[]): unknown[] {
  return nodes.map(cloneValue);
}

/**
 * Converts legacy recursive navigation into the editor's only supported shape:
 * headings and pages are siblings inside a section. Route depth is carried by
 * the href and never means that one page owns another page.
 */
function flattenNavigationNodes(nodes: readonly unknown[]): unknown[] {
  const flattened: unknown[] = [];

  for (const value of nodes) {
    if (!isRecord(value)) {
      flattened.push(cloneValue(value));
      continue;
    }

    const { items, ...node } = value;
    if (Object.keys(node).length > 0) flattened.push(cloneValue(node));
    if (Array.isArray(items)) flattened.push(...flattenNavigationNodes(items));
  }

  return flattened;
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]),
  );
}

function isHeadingNode(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.heading === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new DocsContentError("invalid", message);
}
