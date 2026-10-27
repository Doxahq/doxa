/**
 * Markup rules for generated pages, from the security audit (F6).
 *
 * Links to other sites stay: a page may point readers anywhere. Three things
 * must not reach a published page from generated text:
 * - content hidden from readers, which search engines and crawlers still read
 *   (`className="hidden"`, a `hidden` attribute);
 * - media from another site, which the reader's browser loads on every visit
 *   (a tracking pixel in a Card `image` or a Markdown image);
 * - raw HTML that the page does not need, such as `<script>` or `<a>`.
 *
 * {@link sanitizeGeneratedMarkup} removes the first two without a retry.
 * {@link findUnsafeMarkup} reports the third, so the writer rewrites the page.
 * Both skip fenced code and inline code, where such text is an example.
 * The renderer keeps support for all of it: an owner can still add it by hand.
 */

/** Raw HTML elements that a generated page never contains. */
const UNSAFE_ELEMENTS = [
  "a",
  "base",
  "embed",
  "form",
  "iframe",
  "input",
  "link",
  "meta",
  "object",
  "script",
  "style",
  "svg",
  "textarea",
] as const;

// Lowercase only: `<Embed>` is a runtime component, `<embed>` is raw HTML.
const UNSAFE_ELEMENT_PATTERN = new RegExp(`<\\/?(${UNSAFE_ELEMENTS.join("|")})(?=[\\s/>]|$)`);
const EVENT_HANDLER_ATTRIBUTE = /<[A-Za-z][^>]*\son[a-z]+\s*=/i;
const HIDING_STYLE = /\bstyle\s*=\s*[{"'][^>]*(?:display\s*:\s*["']?none|visibility\s*:\s*["']?hidden)/i;

/** Tailwind classes that hide an element or make it unreadable. */
const HIDING_CLASSES = new Set([
  "hidden",
  "invisible",
  "collapse",
  "sr-only",
  "opacity-0",
  "h-0",
  "w-0",
  "size-0",
  "max-h-0",
  "max-w-0",
  "scale-0",
  "scale-x-0",
  "scale-y-0",
  "text-transparent",
]);
const HIDING_ARBITRARY_VALUE = /^[a-z-]*\[(?:display:none|visibility:hidden|opacity:0|0|0px)\]$/;

/** `http:`, `https:` or protocol-relative: a resource on another site. */
const OUTSIDE_URL = /^\s*(?:https?:)?\/\//i;

export interface UnsafeMarkup {
  /** 0-based line in the checked text. */
  line: number;
  snippet: string;
  reason: string;
}

/** The first raw HTML that a generated page must not contain, or null. */
export function findUnsafeMarkup(text: string): UnsafeMarkup | null {
  let found: UnsafeMarkup | null = null;
  forEachProseSegment(text, (segment, line, lineText) => {
    if (found) return segment;
    const element = UNSAFE_ELEMENT_PATTERN.exec(segment);
    const reason = element
      ? `raw <${element[1]}> element`
      : EVENT_HANDLER_ATTRIBUTE.test(segment)
        ? "event handler attribute"
        : HIDING_STYLE.test(segment)
          ? "style that hides content"
          : null;
    if (reason) found = { line, snippet: lineText.trim(), reason };
    return segment;
  });
  return found;
}

/**
 * The page with hiding classes, `hidden` attributes and media from other
 * sites removed. Text without them comes back unchanged.
 */
export function sanitizeGeneratedMarkup(text: string): string {
  return forEachProseSegment(text, (segment) =>
    segment
      .replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (image, alt: string, url: string) =>
        OUTSIDE_URL.test(url) ? alt : image
      )
      .replace(/<img\b[^>]*>/gi, (tag) => (OUTSIDE_URL.test(attributeValue(tag, "src") ?? "") ? "" : tag))
      .replace(/(\s+)(image|src|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*["'`]([^"'`]*)["'`]\s*\})/g,
        (attribute, _space: string, _name: string, ...values: Array<string | undefined>) =>
          OUTSIDE_URL.test(values.slice(0, 3).find((value) => value !== undefined) ?? "") ? "" : attribute
      )
      .replace(/(\s+)(className|class)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
        (attribute, space: string, name: string, double?: string, single?: string) => {
          const classes = (double ?? single ?? "").split(/\s+/).filter(Boolean);
          const kept = classes.filter((value) => !isHidingClass(value));
          if (kept.length === classes.length) return attribute;
          return kept.length === 0 ? "" : `${space}${name}="${kept.join(" ")}"`;
        })
      .replace(/(<[A-Za-z][^>]*?)\s+hidden(?:\s*=\s*(?:\{\s*true\s*\}|"[^"]*"|'[^']*'))?(?=[\s/>])/g, "$1")
  );
}

function isHidingClass(value: string): boolean {
  // `md:hidden` and `!hidden` hide too: check the utility after any variant.
  const utility = value.split(":").pop()!.replace(/^!/, "");
  return HIDING_CLASSES.has(utility) || HIDING_ARBITRARY_VALUE.test(utility);
}

function attributeValue(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*["'\`]([^"'\`]*)["'\`]\\s*\\})`, "i").exec(tag);
  return match ? match[1] ?? match[2] ?? match[3] : undefined;
}

/**
 * Applies `transform` to each part of each line outside fenced code and
 * inline code, and returns the text with the transformed parts.
 */
function forEachProseSegment(
  text: string,
  transform: (segment: string, line: number, lineText: string) => string,
): string {
  let fence: string | null = null;
  return text.split("\n").map((lineText, line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(lineText)?.[1];
    if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return lineText;
    }
    if (marker) {
      fence = marker;
      return lineText;
    }
    // Odd parts are inline code spans.
    return lineText
      .split(/(`+[^`]*`+)/)
      .map((part, index) => (index % 2 === 1 ? part : transform(part, line, lineText)))
      .join("");
  }).join("\n");
}
