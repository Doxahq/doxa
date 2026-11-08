/**
 * The kept tree of an SVG while it is cleaned: plain data, so the cleaner can
 * decide what stays without changing the parsed document.
 */

/** `#id`: the only `href` form that the cleaner keeps. */
export const LOCAL_HREF = /^#([A-Za-z_][\w:.-]*)$/;
/** `url(#id)`: the only `url()` form that the cleaner keeps in an attribute. */
export const LOCAL_URL = /url\(#([A-Za-z_][\w:.-]*)\)/g;

export interface KeptAttribute {
  name: string;
  namespaceURI: string | null;
  value: string;
  /** Set by the reference rules: the attribute is left out of the output. */
  dropped: boolean;
}

export interface PlannedElement {
  tagName: string;
  namespaceURI: string | null;
  attributes: KeptAttribute[];
  children: PlannedNode[];
  /** Set by the reference rules: the element is left out of the output. */
  dropped: boolean;
}

export type PlannedNode =
  | { kind: "element"; element: PlannedElement }
  | { kind: "text"; data: string }
  | { kind: "cdata"; data: string };

export interface SvgPlan {
  root: PlannedElement;
  /** Every kept element, in document order. */
  elements: readonly PlannedElement[];
  /**
   * The elements of each ID, in document order. A browser resolves `#id` to
   * the first one that is in the output. The reference rules can leave that
   * one out, so they measure a reference against every element of its ID.
   */
  byId: ReadonlyMap<string, readonly PlannedElement[]>;
}

export function childElements(element: PlannedElement): PlannedElement[] {
  return element.children.flatMap((node) => (node.kind === "element" ? [node.element] : []));
}
