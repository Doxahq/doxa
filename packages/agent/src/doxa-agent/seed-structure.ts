import type { DocPage, DocSection, DocumentationStructure } from "../types";
import { normalizeRoute, routeFromOutputPath, slugify } from "./route-registry";
import { flattenStructure, stablePageId } from "./structure-utils";

/** One navigation entry of a hand-written site: a group heading or a page. */
export type SeedNavigationNode =
  | { heading: string }
  | { title: string; href: string };

export interface SeedSection {
  slug: string;
  label: string;
  isDefault: boolean;
  nodes: readonly SeedNavigationNode[];
}

export interface SeedPage {
  href: string;
  title: string;
  description?: string;
}

const HOME_PAGE_ID = "overview";

/**
 * The documentation structure of a hand-written site, as the planner's
 * anchor for a first generation. Each page keeps its exact route as its
 * canonical route, its navigation group, and its title. A page that the
 * navigation does not list joins the default section.
 */
export function seedStructureFromSite(input: {
  sections: readonly SeedSection[];
  pages: readonly SeedPage[];
}): DocumentationStructure {
  const pagesByHref = new Map(
    input.pages.map((page) => [normalizeRoute(page.href), page]),
  );
  const placed = new Set<string>();
  const sections: DocSection[] = input.sections.map((section) => {
    const pages: DocPage[] = [];
    let group: string | undefined;

    for (const node of section.nodes) {
      if ("heading" in node) {
        group = node.heading;
        continue;
      }

      const href = normalizeRoute(node.href);
      const page = pagesByHref.get(href);
      if (!page || placed.has(href)) continue;
      placed.add(href);
      pages.push(seedPage(section, page, node.title, group, pages));
    }

    return {
      id: section.slug,
      title: section.label,
      pages,
      ...(section.isDefault ? { default: true } : {}),
    };
  });

  const unplaced = input.pages.filter(
    (page) => !placed.has(normalizeRoute(page.href)),
  );
  if (unplaced.length > 0) {
    const fallback = defaultSection(sections);
    for (const page of unplaced) {
      fallback.pages.push(
        seedPage(
          { slug: fallback.id, isDefault: true },
          page,
          page.title,
          undefined,
          fallback.pages,
        ),
      );
    }
  }

  return { sections: sections.filter((section) => section.pages.length > 0) };
}

/** The route of every page of a structure, by stable page ID. */
export function pageRoutesById(
  structure: DocumentationStructure,
): Map<string, string> {
  return new Map(
    flattenStructure(structure).map((target) => [
      stablePageId(target),
      routeFromOutputPath(target.path),
    ]),
  );
}

/**
 * The hand-written text for the given pages, by stable page ID. A page whose
 * route the seed does not have gets no entry, so its writer starts from the
 * code alone. Only the requested pages are included, to keep each writer's
 * context to its own page.
 */
export function seedTextForPages(
  structure: DocumentationStructure,
  pageIds: readonly string[],
  bodiesByRoute: ReadonlyMap<string, string>,
): Record<string, string> {
  const routes = pageRoutesById(structure);
  const texts: Record<string, string> = {};

  for (const pageId of pageIds) {
    const route = routes.get(pageId);
    const body = route ? bodiesByRoute.get(normalizeRoute(route)) : undefined;
    if (body !== undefined) texts[pageId] = body;
  }

  return texts;
}

function seedPage(
  section: Pick<SeedSection, "slug" | "isDefault">,
  page: SeedPage,
  navigationTitle: string,
  group: string | undefined,
  siblings: readonly DocPage[],
): DocPage {
  const title = navigationTitle.trim() || page.title;
  return {
    id: uniquePageId(seedPageId(section, page.href), siblings),
    title,
    description: page.description?.trim() || title,
    canonicalRoute: normalizeRoute(page.href),
    ...(group ? { group } : {}),
  };
}

/** The page ID from the route, without the section prefix. */
function seedPageId(
  section: Pick<SeedSection, "slug" | "isDefault">,
  href: string,
): string {
  const segments = normalizeRoute(href).split("/").filter(Boolean);
  const local =
    !section.isDefault && segments[0] === section.slug
      ? segments.slice(1)
      : segments;
  return local.length > 0 ? slugify(local.join("-")) : HOME_PAGE_ID;
}

function uniquePageId(candidate: string, siblings: readonly DocPage[]): string {
  const taken = new Set(siblings.map((page) => page.id));
  let id = candidate;
  for (let suffix = 2; taken.has(id); suffix += 1) {
    id = `${candidate}-${suffix}`;
  }
  return id;
}

function defaultSection(sections: DocSection[]): DocSection {
  const existing = sections.find((section) => section.default);
  if (existing) return existing;

  const created: DocSection = { id: "docs", title: "Docs", pages: [], default: true };
  sections.unshift(created);
  return created;
}
