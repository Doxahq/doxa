import {
  normalizeRuntimeHref,
  type DoxaDocsRuntimeSource,
  type RuntimeSection,
} from "@/src/runtime/runtime-source";

/** One linked page of a site's navigation. */
export interface SiteRoute {
  href: string;
  title: string;
}

/**
 * The linked pages of each section, in navigation order. A page listed in
 * more than one section appears only in the first.
 */
export async function listSectionRoutes(
  source: DoxaDocsRuntimeSource,
  sections: readonly RuntimeSection[]
): Promise<SiteRoute[][]> {
  const routes = await Promise.all(
    sections.map((section) => source.getRoutes(section.slug))
  );
  const seen = new Set<string>();
  return routes.map((sectionRoutes) =>
    sectionRoutes.flatMap((route) => {
      const href = normalizeRuntimeHref(route.href);
      if (seen.has(href)) return [];
      seen.add(href);
      return [{ href, title: route.title }];
    })
  );
}

/** The sections that a visitor can see: hidden sections are left out. */
export async function listVisibleSections(
  source: DoxaDocsRuntimeSource
): Promise<RuntimeSection[]> {
  return (await source.getSections()).filter((section) => !section.hidden);
}
