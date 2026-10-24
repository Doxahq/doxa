import type { Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import remarkStringify, { type Options as StringifyOptions } from "remark-stringify";
import { unified } from "unified";

import { readFrontmatter } from "./frontmatter";

/**
 * The one Markdown style every Doxa writer emits: the generation agent and the
 * dashboard editor. It matches what generated pages already use, so formatting
 * a generated page changes as little text as possible.
 */
export const MDX_FORMAT_OPTIONS: StringifyOptions = {
  bullet: "-",
  bulletOrdered: ".",
  emphasis: "_",
  strong: "*",
  fence: "`",
  rule: "-",
  setext: false,
  listItemIndent: "one",
  incrementListMarker: true,
};

/**
 * Node and attribute types that carry JavaScript. The serializer rewrites the
 * whitespace inside them (for example the indentation of a template string in
 * `<Mermaid chart={`…`} />`), which changes the value a component receives. A
 * top-level block that holds one keeps its original text.
 */
const VERBATIM_TYPES = new Set([
  "mdxFlowExpression",
  "mdxTextExpression",
  "mdxjsEsm",
  "mdxJsxAttributeValueExpression",
  "mdxJsxExpressionAttribute",
  "html",
]);

const processor = unified()
  .use(remarkParse)
  .use(remarkMdx)
  .use(remarkGfm)
  .use(remarkStringify, MDX_FORMAT_OPTIONS);

/**
 * Writes an MDX page in the shared Doxa style.
 *
 * - The frontmatter text is kept exactly.
 * - A top-level block that contains JavaScript keeps its original text.
 * - A body that does not parse comes back unchanged, so the caller's
 *   validation reports the error as it would without formatting.
 *
 * The rendered page does not change: `parseRuntimeMdx` gives the same document
 * for the input and the output. The function is idempotent.
 */
export function formatMdx(source: string): string {
  const { content: body } = readFrontmatter(source);
  const head = source.slice(0, source.length - body.length);

  let tree: Root;
  try {
    tree = processor.parse(body);
  } catch {
    return source;
  }

  tree.children = tree.children.map((node) => keepVerbatimBlock(node, body));
  return head + processor.stringify(tree);
}

/**
 * Swaps a block that must not be rewritten for a raw node that holds its
 * original text. The serializer writes a raw node's value as it is. A
 * paragraph with a line that starts with `import` or `export` keeps its
 * text too: the source escapes the first letter (`&#105;mport`), and the
 * serializer would print the plain word, which MDX reads as an ESM line.
 */
function keepVerbatimBlock(node: RootContent, body: string): RootContent {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined || !(containsVerbatim(node) || hasEsmKeywordLine(node))) {
    return node;
  }
  return { type: "html", value: body.slice(start, end) };
}

/**
 * Parses an MDX body (no frontmatter) into an mdast tree with source
 * positions, using the same stack as the renderer. Throws on invalid MDX.
 */
export function parseMdxTree(body: string): Root {
  return processor.parse(body);
}

/**
 * Writes an mdast tree in the shared Doxa style. A raw `html` node is written
 * as its value, which is how a caller keeps a block's original text.
 */
export function stringifyMdxTree(tree: Root): string {
  return processor.stringify(tree);
}

/** True when a node or any node inside it carries JavaScript. */
export function containsVerbatim(node: unknown): boolean {
  if (!isRecord(node)) return false;
  if (typeof node.type === "string" && VERBATIM_TYPES.has(node.type)) return true;

  for (const key of ["attributes", "children"] as const) {
    const list = node[key];
    if (Array.isArray(list) && list.some(containsVerbatim)) return true;
  }
  // An attribute holds its expression in `value`.
  return isRecord(node.value) && containsVerbatim(node.value);
}

/** True for a paragraph whose text has a line that starts with `import` or `export`. */
function hasEsmKeywordLine(node: RootContent): boolean {
  return node.type === "paragraph" &&
    node.children.some((child) => child.type === "text" && /(?:^|\n)(?:import|export)\b/.test(child.value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
