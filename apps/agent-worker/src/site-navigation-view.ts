import { normalizeHref, UNGROUPED_NAVIGATION_HEADING } from "@doxahq/docs-engine";
import type { SiteNavigation } from "./seed-site";

/** Where the navigation of a version shows one page. */
export interface PagePlacement {
  /** The slug of the section that lists the page. */
  section: string;
  /** The heading over the page, or undefined for no group. */
  group: string | undefined;
  /** The position of the page across all the navigation, from 0. */
  index: number;
}

/** What one version shows of its pages, by normalized route. */
export interface SiteNavigationView {
  /** Pages that no navigation lists have no placement. */
  placements: ReadonlyMap<string, PagePlacement>;
  /** The manifest title of every page. */
  titles: ReadonlyMap<string, string>;
  /** The label of every section, by slug. */
  sectionLabels: ReadonlyMap<string, string>;
}

/**
 * Reads the placements, titles and section labels of one version. The
 * heading over ungrouped pages means no group. A page that two navigations
 * list keeps its first placement.
 */
export function siteNavigationView(navigation: SiteNavigation): SiteNavigationView {
  const placements = new Map<string, PagePlacement>();
  for (const section of navigation.sections) {
    let group: string | undefined;
    for (const node of section.nodes) {
      if ("heading" in node) {
        group = node.heading === UNGROUPED_NAVIGATION_HEADING ? undefined : node.heading;
        continue;
      }
      const href = normalizeHref(node.href);
      if (!placements.has(href)) placements.set(href, { section: section.slug, group, index: placements.size });
    }
  }

  return {
    placements,
    titles: new Map(navigation.pages.map((page) => [normalizeHref(page.href), page.title])),
    sectionLabels: new Map(navigation.sections.map((section) => [section.slug, section.label])),
  };
}

/**
 * The value that a person set: the live value where it differs from what the
 * generation published, else the stored value. A field that the generation
 * derives when it publishes (a navigation heading, the page order) then
 * follows the live site only where a person changed it.
 */
export function personsValue<T>(stored: T, generated: T, live: T): T {
  return generated === live ? stored : live;
}
