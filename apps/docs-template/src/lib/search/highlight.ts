import { escapeHtml } from "@doxahq/contracts/html-escape";

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The text as HTML with each search term in a `<mark>`. The terms are found in
 * the raw text and every piece is escaped after, so a term such as `amp` never
 * lands inside an entity like `&amp;`.
 */
export function highlightTerms(text: string, terms: string[]): string {
  const cleanTerms = terms
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map(escapeRegex);
  if (cleanTerms.length === 0) return escapeHtml(text);
  // With one capture group, split puts each match at an odd index.
  const pattern = new RegExp(`(${cleanTerms.join("|")})`, "gi");
  return text
    .split(pattern)
    .map((piece, index) =>
      index % 2 === 1
        ? `<mark class="search-highlight">${escapeHtml(piece)}</mark>`
        : escapeHtml(piece),
    )
    .join("");
}
