import {
  XMLSerializer,
  type Attr,
  type Node,
  type Document,
  type Element,
} from "@xmldom/xmldom";
import { applyDrawBudget } from "./svg-draw-budget";
import { parseSvgDocument } from "./svg-parser";
import {
  LOCAL_HREF,
  LOCAL_URL,
  type KeptAttribute,
  type PlannedElement,
  type PlannedNode,
  type SvgPlan,
} from "./svg-plan";

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

const SAFE_CSS_FUNCTIONS = new Set([
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

/**
 * A CSS function name and its `(`. The lookbehind starts a match only at the
 * start of a name. Without it, a long name with no `(` makes the regex try
 * again from each of its letters, which is quadratic work.
 */
const CSS_FUNCTION = /(?<![a-z-])([a-z-]+)\s*\(/gi;

function safeStyle(value: string): boolean {
  // Reject CSS escapes and comments as well: they can conceal URL tokens.
  if (
    /[\\@<>\u0000-\u001f]|\/\*|url\s*\(|expression\s*\(|behavior\s*:|-moz-binding/i.test(
      value,
    )
  )
    return false;
  for (const match of value.matchAll(CSS_FUNCTION)) {
    if (!SAFE_CSS_FUNCTIONS.has(match[1].toLowerCase())) return false;
  }
  return true;
}

function safeAttributeValue(value: string): boolean {
  if (/[\\<>\u0000-\u001f]|\/\*|@|expression\s*\(/i.test(value)) return false;
  const withoutLocalPaint = value.replace(LOCAL_URL, "");
  return !/url\s*\(/i.test(withoutLocalPaint);
}

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

function isAllowedAttribute(attribute: Attr, allowlist: Allowlist): boolean {
  const name = attribute.name;
  const isHref =
    name === "href" ||
    (name === "xlink:href" && attribute.namespaceURI === XLINK_NAMESPACE);
  if (isHref) return LOCAL_HREF.test(attribute.value);
  return (
    !attribute.namespaceURI &&
    allowlist.attributes.has(name) &&
    (name === "style" ? safeStyle(attribute.value) : safeAttributeValue(attribute.value))
  );
}

function isAllowedChild(element: Element, allowlist: Allowlist): boolean {
  return (
    allowlist.elements.has(element.tagName) &&
    (!element.namespaceURI || element.namespaceURI === SVG_NAMESPACE) &&
    (element.tagName !== "style" || safeStyle(element.textContent ?? ""))
  );
}

/**
 * Pass 1: reads the parsed tree with sibling pointers only and decides what
 * stays. It never changes the parsed document: xmldom re-indexes child
 * lists on every change, which made the old in-place cleaning quadratic.
 */
class SvgPlanner {
  removedCount = 0;
  private readonly byId = new Map<string, PlannedElement[]>();
  private readonly elements: PlannedElement[] = [];

  constructor(private readonly allowlist: Allowlist) {}

  plan(root: Element): SvgPlan {
    const planned = this.element(root);
    const stack: Array<{ source: Element; target: PlannedElement }> = [
      { source: root, target: planned },
    ];
    // Children go on the stack in reverse, so elements are visited in
    // document order.
    while (stack.length) {
      const current = stack.pop();
      if (!current) break;
      this.visit(current.target);
      const below: typeof stack = [];
      for (let child = current.source.firstChild; child; child = child.nextSibling) {
        const node = this.child(child);
        if (!node) continue;
        current.target.children.push(node);
        if (node.kind === "element" && isElement(child)) {
          below.push({ source: child, target: node.element });
        }
      }
      for (let index = below.length - 1; index >= 0; index--) {
        const next = below[index];
        if (next) stack.push(next);
      }
    }
    return { root: planned, elements: this.elements, byId: this.byId };
  }

  private visit(element: PlannedElement): void {
    this.elements.push(element);
    const id = element.attributes.find((attribute) => attribute.name === "id")?.value;
    if (id === undefined) return;
    const sharing = this.byId.get(id);
    if (sharing) sharing.push(element);
    else this.byId.set(id, [element]);
  }

  private child(node: Node): PlannedNode | null {
    if (node.nodeType === 3) return { kind: "text", data: node.nodeValue ?? "" };
    if (node.nodeType === 4) return { kind: "cdata", data: node.nodeValue ?? "" };
    if (isElement(node) && isAllowedChild(node, this.allowlist)) {
      return { kind: "element", element: this.element(node) };
    }
    // Comments go without counting: they hold no content.
    if (node.nodeType !== 8) this.removedCount++;
    return null;
  }

  private element(source: Element): PlannedElement {
    const attributes: KeptAttribute[] = [];
    for (let index = 0; index < source.attributes.length; index++) {
      const attribute = source.attributes.item(index);
      if (!attribute) continue;
      if (isAllowedAttribute(attribute, this.allowlist)) {
        attributes.push({
          name: attribute.name,
          namespaceURI: attribute.namespaceURI,
          value: attribute.value,
          dropped: false,
        });
      } else if (attribute.namespaceURI !== XMLNS_NAMESPACE) {
        // The serializer declares the namespaces that the kept nodes use again.
        this.removedCount++;
      }
    }
    return {
      tagName: source.tagName,
      namespaceURI: source.namespaceURI,
      attributes,
      children: [],
      dropped: false,
    };
  }
}

/** Pass 2: builds the kept tree with appends only, which xmldom does in O(1). */
function buildElement(document: Document, root: PlannedElement): Element {
  const create = (planned: PlannedElement): Element => {
    const element = document.createElementNS(planned.namespaceURI, planned.tagName);
    for (const attribute of planned.attributes) {
      if (attribute.dropped) continue;
      if (attribute.namespaceURI) {
        element.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
      } else {
        element.setAttribute(attribute.name, attribute.value);
      }
    }
    return element;
  };
  const output = create(root);
  const stack: Array<{ planned: PlannedElement; element: Element }> = [
    { planned: root, element: output },
  ];
  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    for (const node of current.planned.children) {
      if (node.kind === "text") current.element.appendChild(document.createTextNode(node.data));
      else if (node.kind === "cdata") current.element.appendChild(document.createCDATASection(node.data));
      else if (!node.element.dropped) {
        const child = create(node.element);
        current.element.appendChild(child);
        stack.push({ planned: node.element, element: child });
      }
    }
  }
  return output;
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

/**
 * Serialize only the allowlisted SVG subtree, never the input document.
 * The work is linear in the size of the input, and the references in the
 * output draw a bounded number of nodes (see `svg-draw-budget.ts`).
 */
export function cleanSvg(input: string, profile: SvgProfile): CleanedSvg {
  const document = parseSvgDocument(input);
  const root = document.documentElement;
  if (
    !root ||
    root.tagName !== "svg" ||
    (root.namespaceURI && root.namespaceURI !== SVG_NAMESPACE)
  ) {
    throw new Error("Invalid SVG root.");
  }
  const planner = new SvgPlanner(ALLOWLISTS[profile]);
  // Only the root is serialized, so a processing instruction beside it, for
  // example an external stylesheet, is dropped.
  for (let node = document.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 7 && node.nodeName !== "xml") planner.removedCount++;
  }
  const plan = planner.plan(root);
  const removedCount = planner.removedCount + applyDrawBudget(plan);
  const output = buildElement(document, plan.root);
  output.setAttribute("xmlns", SVG_NAMESPACE);
  return { svg: new XMLSerializer().serializeToString(output), removedCount };
}

/** The site asset allowlist: logos, favicons, and social images. */
export function sanitizeSvg(input: string): string {
  return cleanSvg(input, "site").svg;
}
