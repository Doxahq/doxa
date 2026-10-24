import type {
  RuntimeMdxElementNode,
  RuntimeMdxNode,
} from "./types";

/** A heading as a table of contents lists it. */
export interface RuntimeMdxHeading {
  level: number;
  text: string;
  /** `#` and the heading's `id`. */
  href: string;
}

const HEADING_LEVELS: Record<string, number> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

/**
 * The anchor for a heading text: lower case, words joined by `-`, and only
 * letters, digits, `-` and `_` kept. Letters of every script stay.
 */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

/**
 * Gives each heading an `id` from its text, in page order. A repeated text
 * gets `-1`, `-2` and so on, so every anchor is unique on the page. A heading
 * that already has an `id` keeps it. Code blocks are skipped.
 */
export function assignRuntimeMdxHeadingIds(nodes: RuntimeMdxNode[]): void {
  const taken = new Set<string>();
  const repeats = new Map<string, number>();
  for (const heading of headingElements(nodes)) {
    const existing = heading.props?.id;
    if (typeof existing === "string" && existing) {
      taken.add(existing);
      continue;
    }
    const base = headingSlug(textContent(heading)) || "section";
    let count = repeats.get(base) ?? 0;
    let id = count === 0 ? base : `${base}-${count}`;
    while (taken.has(id)) {
      count += 1;
      id = `${base}-${count}`;
    }
    repeats.set(base, count + 1);
    taken.add(id);
    heading.props = { ...heading.props, id };
  }
}

/**
 * The headings of a parsed document between `minLevel` and `maxLevel`, with
 * the anchors that `parseRuntimeMdx` gave them. The table of contents reads
 * this list, so its links always match the rendered headings.
 */
export function runtimeMdxHeadings(
  nodes: RuntimeMdxNode[],
  { minLevel = 2, maxLevel = 4 }: { minLevel?: number; maxLevel?: number } = {},
): RuntimeMdxHeading[] {
  return headingElements(nodes).flatMap((heading) => {
    const level = HEADING_LEVELS[heading.name]!;
    const id = heading.props?.id;
    if (level < minLevel || level > maxLevel || typeof id !== "string") return [];
    return [{ level, text: textContent(heading).trim(), href: `#${id}` }];
  });
}

function headingElements(nodes: RuntimeMdxNode[]): RuntimeMdxElementNode[] {
  const found: RuntimeMdxElementNode[] = [];
  const visit = (node: RuntimeMdxNode) => {
    if (node.type !== "element" || node.name === "pre") return;
    if (node.name in HEADING_LEVELS) {
      found.push(node);
      return;
    }
    node.children?.forEach(visit);
  };
  nodes.forEach(visit);
  return found;
}

function textContent(node: RuntimeMdxNode): string {
  if (node.type === "text") return node.value;
  return node.children?.map(textContent).join("") ?? "";
}
