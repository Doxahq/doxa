import type {
  DocsContentNavigationGroupDto,
  DocsContentNavigationSectionDto,
} from "@doxahq/contracts";
import type { NavigationHeading, NavigationPlacement } from "./artifacts";
import {
  readNavigationHeadings,
  readNavigationPlacements,
  readSections,
  toJsonArtifact,
  type DocsNavigationSection,
} from "./artifacts";
import type { EffectiveContent } from "../docs-branches/effective-tree";

interface PublishedNavigation {
  sections: DocsContentNavigationSectionDto[];
  placementsByHref: Map<string, NavigationPlacement>;
}

export function buildPublishedNavigation(
  navigation: EffectiveContent["navigation"],
  manifestHrefs: ReadonlySet<string>,
): PublishedNavigation {
  const sections = readSections(toJsonArtifact(navigation.sectionsArtifact));
  const sectionsToRead =
    sections.length > 0
      ? sections
      : [
          {
            slug: "default",
            label: "default",
            isDefault: true,
          } satisfies DocsNavigationSection,
        ];
  const placementsByHref = new Map<string, NavigationPlacement>();
  const navigationSections: DocsContentNavigationSectionDto[] = [];

  for (const section of sectionsToRead) {
    const nodes = navigation.documentsBySection.get(section.slug);
    if (!nodes) continue;
    const artifact = toJsonArtifact(nodes);
    const placements = readNavigationPlacements(artifact);
    for (const [href, placement] of placements) {
      const existingIcon = placementsByHref.get(href)?.icon ?? null;
      placementsByHref.set(href, {
        ...placement,
        icon: placement.icon ?? existingIcon,
      });
    }

    if (sections.length === 0) continue;
    const groups = buildNavigationGroups(
      placements,
      readNavigationHeadings(artifact),
      manifestHrefs,
    );
    if (groups.length > 0) navigationSections.push({ ...section, groups });
  }

  return { sections: navigationSections, placementsByHref };
}

/**
 * Groups the pages of one section in navigation order. A heading with no page
 * under it still becomes a group, with no hrefs, so the editor can show it and
 * fill it.
 */
function buildNavigationGroups(
  placements: ReadonlyMap<string, NavigationPlacement>,
  headings: readonly NavigationHeading[],
  manifestHrefs: ReadonlySet<string>,
): DocsContentNavigationGroupDto[] {
  const filled = buildFilledGroups(placements, manifestHrefs);
  const filledIndexes = new Set(filled.map(({ group }) => group.groupIndex));
  const empty: OrderedGroup[] = headings
    .filter(({ groupIndex }) => !filledIndexes.has(groupIndex))
    .map(({ heading, groupIndex, order }) => ({
      group: { heading, groupIndex, hrefs: [] },
      order,
      // At the same order, an empty heading comes before the group that
      // holds the next page.
      rank: 0,
    }));

  return [...filled, ...empty]
    .sort((left, right) => left.order - right.order || left.rank - right.rank)
    .map(({ group }) => group);
}

interface OrderedGroup {
  group: DocsContentNavigationGroupDto;
  /** Navigation order of the group's first page, or of its heading when empty. */
  order: number;
  rank: number;
}

function buildFilledGroups(
  placements: ReadonlyMap<string, NavigationPlacement>,
  manifestHrefs: ReadonlySet<string>,
): OrderedGroup[] {
  const groups: OrderedGroup[] = [];
  const orderedPlacements = [...placements.entries()].sort(
    ([, left], [, right]) => left.order - right.order,
  );

  for (const [href, placement] of orderedPlacements) {
    if (!manifestHrefs.has(href)) continue;

    const current = groups.at(-1)?.group;
    if (
      !current ||
      current.heading !== placement.group ||
      current.groupIndex !== placement.groupIndex
    ) {
      groups.push({
        group: {
          heading: placement.group,
          groupIndex: placement.groupIndex,
          hrefs: [href],
        },
        order: placement.order,
        rank: 1,
      });
      continue;
    }
    current.hrefs.push(href);
  }

  return groups;
}
