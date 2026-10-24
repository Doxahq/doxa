import type {
  Code,
  Heading,
  Image,
  Literal,
  Parent,
  RootContent,
} from "mdast";
import type {
  MdxJsxAttribute,
  MdxJsxFlowElement,
  MdxJsxTextElement,
} from "mdast-util-mdx";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { readFrontmatter } from "./frontmatter";
import { assignRuntimeMdxHeadingIds } from "./headings";
import { hastToRuntimeMdx, isHastNode } from "./highlight/hast-to-runtime";
import { getDocsCodeBlockTransformers } from "./highlight/code-block-transformer";
import { resolveFenceLanguage } from "./highlight/fence-languages";
import {
  isRuntimeMdxComponentName,
  type RuntimeMdxCodeBlockOptions,
  type RuntimeMdxComponentName,
  type RuntimeMdxDocument,
  type RuntimeMdxElementName,
  type RuntimeMdxElementNode,
  type RuntimeMdxIntrinsicName,
  type RuntimeMdxNode,
  type RuntimeMdxParseOptions,
  type RuntimeMdxPropValue,
  type RuntimeMdxTextNode,
} from "./types";

type RuntimeMdastNode = RootContent | MdxJsxFlowElement | MdxJsxTextElement;

export function parseRuntimeMdx(
  source: string,
  options: RuntimeMdxParseOptions = {},
): RuntimeMdxDocument {
  const parsed = readFrontmatter(source);

  try {
    const tree = unified()
      .use(remarkParse)
      .use(remarkMdx)
      .use(remarkGfm)
      .parse(parsed.content);

    const nodes = toRuntimeMdxNodes(tree.children, options);
    // Anchors for the table of contents and for links to a section.
    assignRuntimeMdxHeadingIds(nodes);
    return { frontmatter: parsed.frontmatter, nodes };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const sourceContext = options.sourceLabel
      ? ` for ${options.sourceLabel}`
      : "";
    throw new Error(`Failed to parse runtime MDX${sourceContext}: ${message}`, {
      cause: error,
    });
  }
}

export function toRuntimeMdxNode(
  node: RuntimeMdastNode,
  key: string,
  options: RuntimeMdxParseOptions = {},
): RuntimeMdxNode | null {
  switch (node.type) {
    case "paragraph":
      return createElement("p", {}, toRuntimeMdxNodes(node.children, options));
    case "heading":
      return createElement(
        readHeadingName(node),
        {},
        toRuntimeMdxNodes(node.children, options),
      );
    case "text":
      return createText(node.value);
    case "emphasis":
      return createElement("em", {}, toRuntimeMdxNodes(node.children, options));
    case "strong":
      return createElement(
        "strong",
        {},
        toRuntimeMdxNodes(node.children, options),
      );
    case "inlineCode":
      return createElement("code", {}, [createText(node.value)]);
    case "break":
      return createElement("br");
    case "image":
      return createImage(node, options);
    case "link":
      return createElement(
        "a",
        { href: sanitizeHref(node.url) },
        toRuntimeMdxNodes(node.children, options),
      );
    case "list":
      return createElement(
        node.ordered ? "ol" : "ul",
        {},
        toRuntimeMdxNodes(node.children, options),
      );
    case "listItem":
      return createElement("li", {}, toRuntimeMdxNodes(node.children, options));
    case "blockquote":
      return createElement(
        "blockquote",
        {},
        toRuntimeMdxNodes(node.children, options),
      );
    case "code":
      return createCodeBlock(node, options);
    case "thematicBreak":
      return createElement("hr");
    case "table":
      return createTableNode(node, options);
    case "mdxJsxFlowElement":
    case "mdxJsxTextElement":
      return createMdxComponentNode(node, options);
    case "mdxTextExpression":
    case "mdxFlowExpression":
    case "mdxjsEsm":
      throw new Error(`Unsupported MDX syntax: ${node.type}`);
    case "html":
      return createElement("span", {}, [createText(node.value)]);
    default: {
      const children = readNodeChildren(node);
      const runtimeChildren = toRuntimeMdxNodes(children, options);
      return runtimeChildren.length > 0
        ? createElement("span", { "data-mdx-node": key }, runtimeChildren)
        : null;
    }
  }
}

export function toRuntimeMdxNodes(
  children: readonly RuntimeMdastNode[],
  options: RuntimeMdxParseOptions = {},
): RuntimeMdxNode[] {
  return children
    .map((child, index) =>
      toRuntimeMdxNode(child, `${child.type}-${index}`, options),
    )
    .filter((child): child is RuntimeMdxNode => child !== null);
}

export function createRuntimeMdxCodeBlock(
  source: string,
  options: RuntimeMdxCodeBlockOptions = {},
): RuntimeMdxElementNode {
  const node: Code = {
    type: "code",
    value: source,
    ...(options.language ? { lang: options.language } : {}),
    ...(options.meta ? { meta: options.meta } : {}),
  };

  return createCodeBlock(node, options);
}

function createText(value: string): RuntimeMdxTextNode {
  return { type: "text", value };
}

function createElement(
  name: RuntimeMdxElementName,
  props: Record<string, RuntimeMdxPropValue> = {},
  children: RuntimeMdxNode[] = [],
): RuntimeMdxElementNode {
  return {
    type: "element",
    name,
    ...(Object.keys(props).length > 0 ? { props } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
}

function createCodeBlock(
  node: Code,
  options: RuntimeMdxParseOptions,
): RuntimeMdxElementNode {
  const language = resolveFenceLanguage(node.lang ?? "");
  if (!options.highlighter || !language) return createPlainCodeBlock(node);

  try {
    const highlightedTree = options.highlighter.codeToHast(node.value, {
      lang: language,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
      meta: { __raw: node.meta ?? "" },
      transformers: getDocsCodeBlockTransformers(),
    });
    const highlightedNode: unknown = highlightedTree.children[0];
    if (!isHastNode(highlightedNode)) return createPlainCodeBlock(node);

    const runtimeNode = hastToRuntimeMdx(highlightedNode);
    if (runtimeNode.type !== "element" || runtimeNode.name !== "pre") {
      return createPlainCodeBlock(node);
    }

    return createElement(
      "pre",
      { ...runtimeNode.props, raw: node.value },
      runtimeNode.children ?? [],
    );
  } catch (error) {
    console.warn("[mdx-runtime] Syntax highlighting fallback:", error);
    return createPlainCodeBlock(node);
  }
}

function createPlainCodeBlock(node: Code): RuntimeMdxElementNode {
  const codeProps: Record<string, RuntimeMdxPropValue> = node.lang
    ? { className: `language-${node.lang}` }
    : {};
  const preProps: Record<string, RuntimeMdxPropValue> = {
    raw: node.value,
    ...(node.lang ? { "data-language": node.lang.toLowerCase() } : {}),
  };
  return createElement("pre", preProps, [
    createElement("code", codeProps, [createText(node.value)]),
  ]);
}

function createTableNode(
  node: Parent,
  options: RuntimeMdxParseOptions,
): RuntimeMdxElementNode {
  const [headRow, ...bodyRows] = node.children;
  const children: RuntimeMdxNode[] = [];

  if (headRow) {
    children.push(
      createElement("thead", {}, [
        createElement("tr", {}, createTableCells(headRow, "th", options)),
      ]),
    );
  }

  children.push(
    createElement(
      "tbody",
      {},
      bodyRows.map((row) =>
        createElement("tr", {}, createTableCells(row, "td", options)),
      ),
    ),
  );

  return createElement("table", {}, children);
}

function createTableCells(
  row: RuntimeMdastNode,
  tag: "td" | "th",
  options: RuntimeMdxParseOptions,
): RuntimeMdxNode[] {
  return readNodeChildren(row).map((cell) =>
    createElement(tag, {}, toRuntimeMdxNodes(readNodeChildren(cell), options)),
  );
}

function createMdxComponentNode(
  node: MdxJsxFlowElement | MdxJsxTextElement,
  options: RuntimeMdxParseOptions,
): RuntimeMdxElementNode {
  if (isEscapedHtmlElementName(node.name)) {
    return createElement("span", {}, [createText(stringifyEscapedHtml(node))]);
  }

  const name = readComponentName(node.name);
  const props = readMdxAttributes(node.attributes);
  // A card picture can point at an uploaded image, like a markdown image.
  if (name === "Card" && typeof props.image === "string") {
    props.image = resolveAssetUrl(props.image, options);
  }

  return createElement(
    name,
    props,
    toRuntimeMdxNodes(node.children, options),
  );
}

/**
 * A markdown image. Only `http(s)` and root-relative sources render; any
 * other source, such as `data:` or a relative path, is left out, because the
 * page has no base to resolve it against.
 */
function createImage(
  node: Image,
  options: RuntimeMdxParseOptions,
): RuntimeMdxElementNode | null {
  if (!isRenderableImageSource(node.url)) return null;

  const props: Record<string, RuntimeMdxPropValue> = {
    src: resolveAssetUrl(node.url, options),
    alt: node.alt ?? "",
    loading: "lazy",
    decoding: "async",
  };
  if (node.title) props.title = node.title;
  return createElement("img", props);
}

function isRenderableImageSource(url: string): boolean {
  return /^(https?:\/\/|\/(?!\/))/i.test(url);
}

function resolveAssetUrl(url: string, options: RuntimeMdxParseOptions): string {
  return options.resolveAssetUrl?.(url) ?? url;
}

function isEscapedHtmlElementName(
  name: string | null | undefined,
): name is string {
  return Boolean(
    name && /^[a-z][\w-]*$/.test(name) && !isRuntimeMdxComponentName(name),
  );
}

function stringifyEscapedHtml(
  node: MdxJsxFlowElement | MdxJsxTextElement,
): string {
  const name = node.name ?? "span";
  const attributes = stringifyEscapedHtmlAttributes(node.attributes);
  const children = stringifyEscapedHtmlChildren(node.children);
  return `<${name}${attributes}>${children}</${name}>`;
}

function stringifyEscapedHtmlChildren(
  children: readonly RuntimeMdastNode[],
): string {
  return children
    .map((child) => {
      if (isLiteralNode(child)) return child.value;
      if (isMdxJsxElement(child) && isEscapedHtmlElementName(child.name)) {
        return stringifyEscapedHtml(child);
      }
      return stringifyEscapedHtmlChildren(readNodeChildren(child));
    })
    .join("");
}

function stringifyEscapedHtmlAttributes(
  attributes: readonly MdxJsxFlowElement["attributes"][number][],
): string {
  const props = readMdxAttributes(attributes);
  return Object.entries(props)
    .map(([name, value]) =>
      value === true ? ` ${name}` : ` ${name}="${String(value)}"`,
    )
    .join("");
}

function readComponentName(
  name: string | null | undefined,
): RuntimeMdxComponentName {
  if (isRuntimeMdxComponentName(name)) return name;
  throw new Error(`Unknown MDX component: ${name ?? ""}`);
}

function readHeadingName(node: Heading): RuntimeMdxIntrinsicName {
  switch (node.depth) {
    case 1:
      return "h1";
    case 2:
      return "h2";
    case 3:
      return "h3";
    case 4:
      return "h4";
    case 5:
      return "h5";
    case 6:
      return "h6";
  }
}

function readMdxAttributes(
  attributes: readonly MdxJsxFlowElement["attributes"][number][],
): Record<string, RuntimeMdxPropValue> {
  const props: Record<string, RuntimeMdxPropValue> = {};
  for (const attribute of attributes) {
    if (attribute.type !== "mdxJsxAttribute") continue;
    const value = readMdxAttributeValue(attribute.value);
    if (value !== undefined) props[attribute.name] = value;
  }
  return props;
}

function readMdxAttributeValue(
  value: MdxJsxAttribute["value"],
): RuntimeMdxPropValue | undefined {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value;

  const expression = value.value.trim();
  if (expression === "true") return true;
  if (expression === "false") return false;
  if (/^\d+(?:\.\d+)?$/.test(expression)) return Number(expression);

  return readStringLiteral(expression) ?? expression;
}

const STRING_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

/**
 * The value of a JavaScript string literal: `"…"`, `'…'`, or a template
 * literal without substitutions, such as the `` chart={`graph TD; …`} `` the
 * documentation agent writes for a diagram. Escapes are resolved. Anything
 * else, including a template with `${…}`, returns null.
 */
export function readStringLiteral(expression: string): string | null {
  const quote = expression[0];
  if (
    expression.length < 2 ||
    (quote !== '"' && quote !== "'" && quote !== "`") ||
    expression[expression.length - 1] !== quote
  ) {
    return null;
  }

  let result = "";
  const end = expression.length - 1;
  for (let index = 1; index < end; index += 1) {
    const char = expression[index];
    if (char === quote) return null;
    if (quote === "`" && char === "$" && expression[index + 1] === "{") return null;
    if (char !== "\\") {
      result += char;
      continue;
    }
    index += 1;
    if (index >= end) return null;
    const next = expression[index];
    if (next === "\n") continue;
    if (next === "u" || next === "x") {
      const unicode = /^u\{([0-9a-fA-F]+)\}|^u([0-9a-fA-F]{4})|^x([0-9a-fA-F]{2})/.exec(
        expression.slice(index, end),
      );
      if (!unicode) return null;
      result += String.fromCodePoint(
        parseInt(unicode[1] ?? unicode[2] ?? unicode[3] ?? "0", 16),
      );
      index += unicode[0].length - 1;
      continue;
    }
    result += STRING_ESCAPES[next] ?? next;
  }
  return result;
}

function readNodeChildren(node: RuntimeMdastNode): RuntimeMdastNode[] {
  return isParentNode(node) ? node.children : [];
}

function isParentNode(
  node: RuntimeMdastNode,
): node is RuntimeMdastNode & Parent {
  return "children" in node;
}

function isLiteralNode(
  node: RuntimeMdastNode,
): node is RuntimeMdastNode & Literal {
  return "value" in node && typeof node.value === "string";
}

function isMdxJsxElement(
  node: RuntimeMdastNode,
): node is MdxJsxFlowElement | MdxJsxTextElement {
  return node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement";
}

function sanitizeHref(value: string): string {
  if (/^(https?:|mailto:|#|\/)/i.test(value)) return value;
  return "#";
}
