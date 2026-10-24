import {
  DOMParser,
  XMLSerializer,
  onErrorStopParsing,
  type Element,
} from "@xmldom/xmldom";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
const ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "symbol",
  "use",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "title",
  "desc",
  "clipPath",
  "mask",
  "linearGradient",
  "radialGradient",
  "stop",
  "style",
]);
/**
 * Diagram elements that docs images use, for example arrowheads. They hold no
 * script and no external reference; their `href` is checked like any other.
 */
const DOCS_IMAGE_ELEMENTS = new Set(["marker", "pattern", "textPath"]);
const ATTRIBUTES = new Set([
  "id",
  "class",
  "viewBox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "transform",
  "fill",
  "fill-rule",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "opacity",
  "clip-path",
  "clip-rule",
  "mask",
  "preserveAspectRatio",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "fx",
  "fy",
  "fr",
  "font-family",
  "font-size",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
  "dx",
  "dy",
  "rotate",
  "textLength",
  "lengthAdjust",
  "style",
]);
const DOCS_IMAGE_ATTRIBUTES = new Set([
  "markerWidth",
  "markerHeight",
  "markerUnits",
  "refX",
  "refY",
  "orient",
  "marker-start",
  "marker-mid",
  "marker-end",
  "patternUnits",
  "patternContentUnits",
  "patternTransform",
  "startOffset",
  "font-style",
  "letter-spacing",
  "word-spacing",
  "text-decoration",
  "visibility",
  "display",
  "vector-effect",
  "paint-order",
  "alignment-baseline",
  "baseline-shift",
]);

/**
 * `site` keeps the allowlist of logos and favicons. `docs_image` adds the
 * diagram elements and presentation attributes of images in docs pages.
 */
export type SvgProfile = "site" | "docs_image";

interface Allowlist {
  elements: ReadonlySet<string>;
  attributes: ReadonlySet<string>;
}

const ALLOWLISTS: Record<SvgProfile, Allowlist> = {
  site: { elements: ELEMENTS, attributes: ATTRIBUTES },
  docs_image: {
    elements: new Set([...ELEMENTS, ...DOCS_IMAGE_ELEMENTS]),
    attributes: new Set([...ATTRIBUTES, ...DOCS_IMAGE_ATTRIBUTES]),
  },
};

const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";

function safeStyle(value: string): boolean {
  // Reject CSS escapes and comments as well: they can conceal URL tokens.
  if (
    /[\\@<>\u0000-\u001f]|\/\*|url\s*\(|expression\s*\(|behavior\s*:|-moz-binding/i.test(
      value,
    )
  )
    return false;
  const safeFunctions = new Set([
    "rgb",
    "rgba",
    "hsl",
    "hsla",
    "oklab",
    "oklch",
    "matrix",
    "translate",
    "scale",
    "rotate",
    "skewx",
    "skewy",
  ]);
  return [...value.matchAll(/([a-z-]+)\s*\(/gi)].every((match) =>
    safeFunctions.has(match[1].toLowerCase()),
  );
}

function safeAttributeValue(value: string): boolean {
  if (/[\\<>\u0000-\u001f]|\/\*|@|expression\s*\(/i.test(value)) return false;
  const withoutLocalPaint = value.replace(/url\(#[A-Za-z_][\w:.-]*\)/g, "");
  return !/url\s*\(/i.test(withoutLocalPaint);
}

/** Returns the number of removed attributes. Namespace declarations do not count. */
function cleanAttributes(element: Element, allowlist: Allowlist): number {
  let removed = 0;
  for (let index = element.attributes.length - 1; index >= 0; index--) {
    const attribute = element.attributes.item(index);
    if (!attribute) continue;
    const name = attribute.name;
    const isHref =
      name === "href" ||
      (name === "xlink:href" && attribute.namespaceURI === XLINK_NAMESPACE);
    const allowed = isHref
      ? /^#[A-Za-z_][\w:.-]*$/.test(attribute.value)
      : !attribute.namespaceURI &&
        allowlist.attributes.has(name) &&
        (name === "style"
          ? safeStyle(attribute.value)
          : safeAttributeValue(attribute.value));
    if (allowed) continue;
    element.removeAttributeNode(attribute);
    // The serializer declares the namespaces that the kept nodes use again.
    if (attribute.namespaceURI !== XMLNS_NAMESPACE) removed++;
  }
  return removed;
}

export interface CleanedSvg {
  svg: string;
  /**
   * Elements, attributes, and processing instructions that the allowlist
   * removed. Comments, the XML declaration, and namespace declarations do
   * not count: they hold no content. Zero means the image is unchanged.
   */
  removedCount: number;
}

/** Serialize only the allowlisted SVG subtree, never the input document. */
export function cleanSvg(input: string, profile: SvgProfile): CleanedSvg {
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(input))
    throw new Error("Unsupported SVG declaration.");
  const allowlist = ALLOWLISTS[profile];
  const document = new DOMParser({
    onError: onErrorStopParsing,
  }).parseFromString(input, "image/svg+xml");
  const root = document.documentElement;
  if (
    !root ||
    root.tagName !== "svg" ||
    (root.namespaceURI && root.namespaceURI !== SVG_NAMESPACE)
  ) {
    throw new Error("Invalid SVG root.");
  }
  let removedCount = 0;
  // Only the root is serialized, so a processing instruction beside it, for
  // example an external stylesheet, is dropped.
  for (let node = document.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 7 && node.nodeName !== "xml") removedCount++;
  }
  const pending = [{ element: root, depth: 0 }];
  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    removedCount += cleanAttributes(current.element, allowlist);
    for (let index = current.element.children.length - 1; index >= 0; index--) {
      const element = current.element.children.item(index);
      if (!element) continue;
      if (
        current.depth >= 64 ||
        !allowlist.elements.has(element.tagName) ||
        (element.namespaceURI && element.namespaceURI !== SVG_NAMESPACE) ||
        (element.tagName === "style" && !safeStyle(element.textContent ?? ""))
      ) {
        current.element.removeChild(element);
        removedCount++;
      } else pending.push({ element, depth: current.depth + 1 });
    }
    for (let child = current.element.lastChild; child; ) {
      const previous = child.previousSibling;
      if (
        child.nodeType !== 1 &&
        child.nodeType !== 3 &&
        child.nodeType !== 4
      ) {
        current.element.removeChild(child);
        if (child.nodeType !== 8) removedCount++;
      }
      child = previous;
    }
  }
  root.setAttribute("xmlns", SVG_NAMESPACE);
  return { svg: new XMLSerializer().serializeToString(root), removedCount };
}

/** The site asset allowlist: logos, favicons, and social images. */
export function sanitizeSvg(input: string): string {
  return cleanSvg(input, "site").svg;
}
