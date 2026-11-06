import type { DoxabotPageType } from "@doxahq/contracts/doxabot-instructions";

/**
 * What the planner calls a page: a page type that the owner chooses, or the
 * landing page. A plain list, because the code that parses a plan also runs
 * from `dist/structure.js`, which must stay free of imports. The `satisfies`
 * fails the build when this list and the owner's page types disagree.
 */
export const PLANNED_PAGE_TYPES = [
  "overview",
  "quickstart",
  "guides",
  "reference",
  "concepts",
  "troubleshooting",
] as const satisfies readonly ("overview" | DoxabotPageType)[];

export type PlannedPageType = (typeof PLANNED_PAGE_TYPES)[number];

export function isPlannedPageType(value: unknown): value is PlannedPageType {
  return PLANNED_PAGE_TYPES.some((type) => type === value);
}

/** Only names that say the type outright, because a match removes the page. */
const TITLE_PATTERNS: Readonly<Record<DoxabotPageType, RegExp>> = {
  quickstart: /\b(?:quick ?start|getting started|get started)\b/i,
  guides: /\b(?:guides?|tutorials?|how to|walkthroughs?)\b/i,
  reference: /\b(?:api|sdk) reference\b/i,
  concepts: /\b(?:concepts?|how it works|fundamentals)\b/i,
  troubleshooting: /\b(?:troubleshoot(?:ing)?|faqs?|frequently asked questions|common (?:issues|errors|problems))\b/i,
};

/**
 * A heading that names a troubleshooting section. Narrower than the title
 * pattern: other page templates ask for a "Common errors" section, which a
 * page of another type keeps.
 */
const TROUBLESHOOTING_HEADING = /\b(?:troubleshoot(?:ing)?|faqs?|frequently asked questions)\b/i;

/** The owner's page types, in their fixed order. */
const DOXABOT_PAGE_TYPES_IN_ORDER = PLANNED_PAGE_TYPES.filter(
  (type): type is DoxabotPageType => type !== "overview",
);

/** The page types that a title or heading names outright. */
export function pageTypesNamedBy(text: string): DoxabotPageType[] {
  return DOXABOT_PAGE_TYPES_IN_ORDER.filter((type) => TITLE_PATTERNS[type].test(text));
}

/**
 * The turned-off type that a title or nav heading names, judged by one rule
 * everywhere (plan pages, collection items, nav headings): the text names a
 * type that is off and no type that is on. "Migration guide" with guides off
 * names guides; "Troubleshooting guide" or "Guides & Troubleshooting" with
 * only troubleshooting off names none, because it is also a guide.
 */
export function turnedOffTypeNamedBy(
  text: string,
  turnedOff: ReadonlySet<DoxabotPageType>,
): DoxabotPageType | undefined {
  const named = pageTypesNamedBy(text);
  if (named.some((type) => !turnedOff.has(type))) return undefined;
  return named.find((type) => turnedOff.has(type));
}

/**
 * The turned-off type of a page, if it has one. A page that declares a type is
 * judged by it: the planner declares a type on every page when a type is off.
 * A page without one is judged by its title ({@link turnedOffTypeNamedBy}),
 * and the writer checks keep troubleshooting sections out of a page that stays.
 */
export function turnedOffTypeOfPage(
  page: { pageType?: PlannedPageType; title: string },
  turnedOff: ReadonlySet<DoxabotPageType>,
): DoxabotPageType | undefined {
  if (page.pageType) {
    return page.pageType !== "overview" && turnedOff.has(page.pageType) ? page.pageType : undefined;
  }
  return turnedOffTypeNamedBy(page.title, turnedOff);
}

/** Whether a navigation heading names a page type that is off, such as "Guides" with guides off. */
export function headingNamesTurnedOffType(heading: string, turnedOff: ReadonlySet<DoxabotPageType>): boolean {
  return turnedOffTypeNamedBy(heading, turnedOff) !== undefined;
}

/** A heading that adds a section of this type to a page of another type. */
export function headingNamesPageType(heading: string, type: DoxabotPageType): boolean {
  return type === "troubleshooting" && TROUBLESHOOTING_HEADING.test(heading);
}
