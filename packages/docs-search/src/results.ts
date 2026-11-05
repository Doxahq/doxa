import type { RuntimeSearchResult, SearchIndexLine } from "./contracts";

const MAX_SNIPPET_LENGTH = 180;
const SNIPPET_CONTEXT_RADIUS = 70;

/** A stored document, as any provider returns it. */
export interface StoredSearchResult {
  id: string;
  slug: string;
  title: string;
  breadcrumb: string[];
  icon?: string;
  section?: string;
  lines: SearchIndexLine[];
}

/**
 * One search result in the shape every provider answers with. All providers
 * pick the snippet with this code, so a change of provider does not change it.
 */
export function toSearchResult(input: {
  stored: StoredSearchResult;
  query: string;
  matchedTerms: readonly string[];
  score: number;
}): RuntimeSearchResult {
  const { stored } = input;
  const terms = [
    ...new Set([
      ...extractTerms(input.query),
      ...input.matchedTerms.map((term) => term.toLowerCase()),
    ]),
  ];
  const snippet = pickSnippet(stored.lines, terms);

  return {
    id: stored.id,
    slug: stored.slug,
    title: stored.title,
    breadcrumb: stored.breadcrumb,
    ...(stored.icon ? { icon: stored.icon } : {}),
    ...(stored.section ? { section: stored.section } : {}),
    snippetLine: snippet.text,
    ...(snippet.anchor ? { snippetAnchor: snippet.anchor } : {}),
    score: input.score,
    terms,
  };
}

function extractTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function pickSnippet(
  lines: readonly SearchIndexLine[],
  terms: readonly string[],
): { text: string; anchor?: string } {
  const firstLine = lines.find((line) => line.text.trim().length > 0);
  if (!firstLine) return { text: "" };

  let bestLine = firstLine;
  let bestScore = 0;
  let bestMatchIndex = 0;

  for (const line of lines) {
    const candidate = scoreLine(line.text, terms);
    if (candidate.score <= bestScore) continue;
    bestLine = line;
    bestScore = candidate.score;
    bestMatchIndex = candidate.firstMatchIndex;
  }

  return {
    text: truncateAround(bestLine.text, bestMatchIndex),
    ...(bestLine.anchor ? { anchor: bestLine.anchor } : {}),
  };
}

function scoreLine(
  text: string,
  terms: readonly string[],
): { score: number; firstMatchIndex: number } {
  const lower = text.toLowerCase();
  const seen = new Set<string>();
  let score = 0;
  let firstMatchIndex = 0;
  let hasMatch = false;

  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index < 0) continue;
    if (!hasMatch || index < firstMatchIndex) firstMatchIndex = index;
    hasMatch = true;
    if (!seen.has(term)) {
      score += 10;
      seen.add(term);
    }
    if (index < 40) score += 2;
  }

  return { score, firstMatchIndex };
}

function truncateAround(text: string, anchorIndex: number): string {
  if (text.length <= MAX_SNIPPET_LENGTH) return text;
  const start = Math.max(0, anchorIndex - SNIPPET_CONTEXT_RADIUS);
  const end = Math.min(text.length, start + MAX_SNIPPET_LENGTH);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${
    end < text.length ? "…" : ""
  }`;
}
