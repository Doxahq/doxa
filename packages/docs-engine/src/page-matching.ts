/**
 * Matches the pages of one version of a site to the pages of another. A
 * person can move, rename or edit a page between versions, and no stable
 * page ID survives that, so pages are matched by what they keep:
 *
 * 1. the same route;
 * 2. else the same body, ignoring frontmatter, when exactly one page on
 *    each side has it (a move or a rename that kept the text);
 * 3. else the same title in the same section, when exactly one page on each
 *    side has it (a move that also edited the text).
 *
 * A page matches at most once. The rest are unmatched on either side.
 */

/** What a page keeps across versions. */
export interface MatchablePage {
  /** The page route, normalized. */
  href: string;
  title: string;
  /** The section that lists the page. */
  section: string;
  /** The page source, or null when it could not be read. */
  content: string | null;
}

export type PageMatchReason = "route" | "body" | "title";

export interface PageMatch<Previous, Current> {
  previous: Previous;
  current: Current;
  by: PageMatchReason;
}

export interface PageMatching<Previous, Current> {
  matches: PageMatch<Previous, Current>[];
  /** Pages that the current version no longer has. */
  unmatchedPrevious: Previous[];
  /** Pages that only the current version has. */
  unmatchedCurrent: Current[];
}

const FRONTMATTER = /^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/;

/** The text of a page without its frontmatter, with its outer whitespace trimmed. */
export function pageBody(content: string): string {
  return content.replace(FRONTMATTER, "").trim();
}

export function matchPages<Previous extends MatchablePage, Current extends MatchablePage>(
  previous: readonly Previous[],
  current: readonly Current[],
): PageMatching<Previous, Current> {
  const matches: PageMatch<Previous, Current>[] = [];
  let openPrevious = [...previous];
  let openCurrent = [...current];

  const pairBy = (by: PageMatchReason, keyOf: (page: MatchablePage) => string | null) => {
    const previousByKey = uniqueByKey(openPrevious, keyOf);
    const currentByKey = uniqueByKey(openCurrent, keyOf);
    const matched = new Set<MatchablePage>();
    for (const [key, previousPage] of previousByKey) {
      const currentPage = currentByKey.get(key);
      if (!currentPage) continue;
      matches.push({ previous: previousPage, current: currentPage, by });
      matched.add(previousPage).add(currentPage);
    }
    openPrevious = openPrevious.filter((page) => !matched.has(page));
    openCurrent = openCurrent.filter((page) => !matched.has(page));
  };

  pairBy("route", (page) => page.href);
  pairBy("body", (page) => {
    const body = page.content === null ? "" : pageBody(page.content);
    return body ? body : null;
  });
  pairBy("title", (page) => `${page.section}\u0000${page.title.trim().toLowerCase()}`);

  return { matches, unmatchedPrevious: openPrevious, unmatchedCurrent: openCurrent };
}

/** The pages whose key no other page shares, by that key. */
function uniqueByKey<Page extends MatchablePage>(
  pages: readonly Page[],
  keyOf: (page: MatchablePage) => string | null,
): Map<string, Page> {
  const byKey = new Map<string, Page>();
  const repeated = new Set<string>();
  for (const page of pages) {
    const key = keyOf(page);
    if (key === null) continue;
    if (byKey.has(key)) repeated.add(key);
    else byKey.set(key, page);
  }
  for (const key of repeated) byKey.delete(key);
  return byKey;
}
