/**
 * A small tag scanner for the few things that branding reads from a page:
 * head links and metas, anchors, the header and footer, inline SVGs, and
 * JSON-LD. It does not build a DOM; it is tolerant of broken markup.
 */

export type Attributes = Record<string, string>;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

export function decodeEntities(value: string): string {
  return value
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (match, name: string) => {
      const lower = name.toLowerCase();
      if (ENTITIES[lower]) return ENTITIES[lower];
      if (lower.startsWith("#x")) return safeCodePoint(parseInt(lower.slice(2), 16)) ?? match;
      if (lower.startsWith("#")) return safeCodePoint(Number(lower.slice(1))) ?? match;
      return match;
    });
}

function safeCodePoint(code: number): string | null {
  return Number.isInteger(code) && code > 31 && code < 0x110000 ? String.fromCodePoint(code) : null;
}

export function parseAttributes(tag: string): Attributes {
  const attributes: Attributes = {};
  const body = tag.replace(/^<\/?[a-z0-9-]+/i, "").replace(/\/?>$/, "");
  for (const match of body.matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g)) {
    attributes[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

/** Every opening tag with this name, with its attributes. */
export function findTags(html: string, name: string): Attributes[] {
  const pattern = new RegExp(`<${name}\\b[^>]*>`, "gi");
  return [...html.matchAll(pattern)].map((match) => parseAttributes(match[0]));
}

/** The first element with this name, from its opening to its closing tag. */
export function firstElement(html: string, name: string): string | null {
  return elements(html, name)[0] ?? null;
}

/** Every top-level element with this name, nesting counted. */
export function elements(html: string, name: string): string[] {
  const pattern = new RegExp(`<(/?)${name}\\b[^>]*>`, "gi");
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (const match of html.matchAll(pattern)) {
    const index = match.index ?? 0;
    const closing = match[1] === "/";
    const selfClosing = !closing && match[0].endsWith("/>");
    if (!closing) {
      if (depth === 0) start = index;
      if (selfClosing) {
        if (depth === 0) out.push(match[0]);
        continue;
      }
      depth += 1;
    } else if (depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(html.slice(start, index + match[0].length));
        start = -1;
      }
    }
  }
  return out;
}

export function textContent(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export interface Anchor {
  href: string;
  text: string;
  /** Offset of the anchor in the scanned HTML. */
  index: number;
}

export function anchors(html: string): Anchor[] {
  const out: Anchor[] = [];
  for (const match of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    const attributes = parseAttributes(match[0].slice(0, match[0].indexOf(">") + 1));
    if (!attributes.href) continue;
    out.push({
      href: attributes.href,
      text: textContent(match[1]) || attributes["aria-label"] || attributes.title || "",
      index: match.index ?? 0,
    });
  }
  return out;
}

/** Parsed JSON-LD blocks; invalid blocks are skipped. */
export function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      out.push(JSON.parse(match[1]));
    } catch {
      // Skip the block.
    }
  }
  return out;
}

export function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}
