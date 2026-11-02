/**
 * HTML escaping for every server that builds HTML from strings. One copy, so
 * the escapers of the API, the docs runtime and the docs renderer cannot drift
 * apart.
 */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const HTML_SPECIAL_CHARACTERS = /[&<>"']/g;

/**
 * Escapes text for HTML element content and for an attribute value in double
 * or single quotes. It does not make a value safe anywhere else: an unquoted
 * attribute, a URL attribute (check the scheme first), an event or `style`
 * attribute, or the body of `<script>` or `<style>`.
 */
export function escapeHtml(value: string): string {
  return value.replace(HTML_SPECIAL_CHARACTERS, (character) => HTML_ESCAPES[character] ?? character);
}
