/**
 * The form of a stored icon name: camelCase letters and digits, as Lucide
 * names read in camelCase (`book-open` is `bookOpen`). Keep in step with
 * `DOCS_PAGE_ICON_PATTERN` in `@doxahq/contracts`.
 */
export const DOCS_ICON_NAME_PATTERN = /^[a-z][A-Za-z0-9]{0,39}$/;

/**
 * The lookup key for an icon name from a page, or null when it cannot be an
 * icon. Pages store camelCase, but MDX written by hand often uses the Lucide
 * site's kebab-case (`book-open`), so both work.
 */
export function docsIconKey(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (DOCS_ICON_NAME_PATTERN.test(trimmed)) return trimmed;
  // PascalCase, as `lucide-react` exports name them (`BookOpen`).
  if (/^[A-Z][A-Za-z0-9]*$/.test(trimmed)) {
    const camel = trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
    return DOCS_ICON_NAME_PATTERN.test(camel) ? camel : null;
  }
  const camel = trimmed
    .toLowerCase()
    .replace(/[-_\s]+([a-z0-9])/g, (_, character: string) => character.toUpperCase());
  return DOCS_ICON_NAME_PATTERN.test(camel) ? camel : null;
}

/** "bookOpen" reads as "Book open", and "arrowDown01" as "Arrow down 01". */
export function docsIconLabel(name: string): string {
  const words = name
    .replace(/([A-Z])/g, " $1")
    .replace(/([a-zA-Z]{2})(\d)/g, "$1 $2")
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
