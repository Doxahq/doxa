import type { RuntimeMdxPropValue } from "@doxahq/mdx-runtime";

type MdxProps = Readonly<Record<string, RuntimeMdxPropValue>>;

/**
 * Tailwind utilities that lift an element out of its place in the page:
 * fixed, absolute or sticky positioning, offsets and stacking order. MDX is
 * untrusted (repository text, agents, teammates), and with these a page
 * could draw `<Card className="fixed inset-0 z-50">` over the whole
 * dashboard or docs site and turn it into a phishing link (SEC-009).
 *
 * Matched after any variant prefixes (`md:`, `hover:`), the important mark
 * (`!`) and a minus sign, so `md:!-top-4` counts too.
 */
const POSITIONING_UTILITY =
  /^(?:fixed|absolute|sticky|inset(?:-[xy])?-.+|(?:top|right|bottom|left|start|end)-.+|z-.+)$/;

/** Arbitrary properties such as `[position:fixed]` can set anything. */
const ARBITRARY_PROPERTY = /^\[[^\]]*\]$/;

/**
 * The class token without its variants, important mark and minus sign. A
 * colon inside brackets belongs to an arbitrary value, not to a variant.
 */
function utilityName(token: string): string {
  let depth = 0;
  let utilityStart = 0;
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index];
    if (char === "[") depth += 1;
    else if (char === "]") depth = Math.max(0, depth - 1);
    else if (char === ":" && depth === 0) utilityStart = index + 1;
  }
  return token.slice(utilityStart).replace(/^!?-?/, "");
}

function isAllowedClass(token: string): boolean {
  const utility = utilityName(token);
  return !POSITIONING_UTILITY.test(utility) && !ARBITRARY_PROPERTY.test(utility);
}

/** The class list without positioning utilities. Every other class stays. */
export function withoutPositioningClasses(className: string): string {
  return className.split(/\s+/).filter((token) => token.length > 0 && isAllowedClass(token)).join(" ");
}

/**
 * The props of an MDX element, safe to render:
 * - `className` loses its positioning utilities and keeps every other class,
 *   so published pages keep their spacing, colours and layout;
 * - a string `style` is dropped: MDX attributes are text, and React refuses a
 *   string style, so it could only break the page.
 */
export function safeMdxProps(props: MdxProps | undefined): Record<string, RuntimeMdxPropValue> {
  const safe: Record<string, RuntimeMdxPropValue> = {};
  for (const [name, value] of Object.entries(props ?? {})) {
    if (name === "style" && typeof value === "string") continue;
    safe[name] = name === "className" && typeof value === "string" ? withoutPositioningClasses(value) : value;
  }
  return safe;
}
