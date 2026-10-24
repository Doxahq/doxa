import { createElement, type SVGProps } from "react";

import { DOCS_ICON_ATTRIBUTES, DOCS_ICON_ELEMENTS, type DocsIconNode } from "./node";

const ELEMENTS: ReadonlySet<string> = new Set(DOCS_ICON_ELEMENTS);
const ATTRIBUTES: ReadonlySet<string> = new Set(DOCS_ICON_ATTRIBUTES);

export interface DocsIconSvgProps extends Omit<SVGProps<SVGSVGElement>, "children" | "ref"> {
  /** The icon to draw. Without one the frame stays empty, so a loading icon keeps its size. */
  node: DocsIconNode | null | undefined;
}

/**
 * Draws icon data in the Lucide frame: 24×24, a 2px round stroke in the
 * current text color, no fill. It matches `lucide-react`, so a size class or
 * `strokeWidth` works the same.
 */
export function DocsIconSvg({ node, strokeWidth = 2, ...props }: DocsIconSvgProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={props["aria-label"] ? undefined : true}
      {...props}
    >
      {node?.map(([element, attributes], index) =>
        ELEMENTS.has(element) ? createElement(element, { key: index, ...allowedAttributes(attributes) }) : null,
      )}
    </svg>
  );
}

function allowedAttributes(attributes: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const allowed: Record<string, string> = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (ATTRIBUTES.has(name) && typeof value === "string") allowed[name] = value;
  }
  return allowed;
}
