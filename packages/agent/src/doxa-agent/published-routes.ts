import type { DocPage, DocSection, DocumentationStructure } from "../types";
import { normalizeRoute, pageOutputPath, routeFromOutputPath } from "./route-registry";

/**
 * Keeps the published route of every page that a new plan kept.
 *
 * A model plans the structure from page IDs; it never writes routes. A page
 * that a person moved, or whose route the live site set, carries that route
 * as `canonicalRoute`. Without this step a new plan would drop it and move
 * the page to the route of its ID.
 *
 * A page is the same page when its section ID and page ID match. The model
 * still decides which pages exist: a dropped page stays dropped, and a new
 * page gets the route of its ID. When a new page's route would clash with a
 * kept route, the kept page keeps it and the new page gets a free one.
 */
export function keepPublishedRoutes(
  structure: DocumentationStructure,
  published: DocumentationStructure | null | undefined,
): DocumentationStructure {
  if (!published) return structure;

  const publishedRoutes = publishedCanonicalRoutes(published);
  const withKeptRoutes = mapPages(structure, (section, page) => {
    const route = publishedRoutes.get(pageKey(section.id, page.id));
    return route && page.canonicalRoute === undefined ? { ...page, canonicalRoute: route } : page;
  });
  return withUniqueRoutes(withKeptRoutes);
}

function publishedCanonicalRoutes(published: DocumentationStructure): Map<string, string> {
  const routes = new Map<string, string>();
  for (const section of published.sections) {
    for (const page of section.pages) {
      if (page.canonicalRoute) routes.set(pageKey(section.id, page.id), normalizeRoute(page.canonicalRoute));
    }
  }
  return routes;
}

/** Pages with a kept route claim it first; any other page that would land on a taken route moves to a free one. */
function withUniqueRoutes(structure: DocumentationStructure): DocumentationStructure {
  const taken = new Set<string>();
  for (const section of structure.sections) {
    for (const page of section.pages) {
      if (page.canonicalRoute) taken.add(routeOf(section, page));
    }
  }

  return mapPages(structure, (section, page) => {
    if (page.canonicalRoute) return page;
    const route = routeOf(section, page);
    if (!taken.has(route)) {
      taken.add(route);
      return page;
    }
    const free = freeRoute(route, taken);
    taken.add(free);
    return { ...page, canonicalRoute: free };
  });
}

function freeRoute(route: string, taken: ReadonlySet<string>): string {
  let suffix = 2;
  while (taken.has(`${route}-${suffix}`)) suffix += 1;
  return `${route}-${suffix}`;
}

function routeOf(section: DocSection, page: DocPage): string {
  return routeFromOutputPath(pageOutputPath(section, page));
}

function pageKey(sectionId: string, pageId: string): string {
  return `${sectionId}/${pageId}`;
}

function mapPages(
  structure: DocumentationStructure,
  map: (section: DocSection, page: DocPage) => DocPage,
): DocumentationStructure {
  return {
    ...structure,
    sections: structure.sections.map((section) => ({
      ...section,
      pages: section.pages.map((page) => map(section, page)),
    })),
  };
}
