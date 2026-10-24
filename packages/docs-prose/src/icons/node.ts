/**
 * An icon as data: the SVG elements inside a 24×24 Lucide frame.
 *
 * Icons travel as data, not components, so that a host can send only the
 * icons a page uses (the docs renderer puts them in its route data) or load
 * the full set lazily (the dashboard). Drawing builds React elements from an
 * allowlist, never markup, so icon data cannot inject anything into a page.
 */

/** The SVG elements an icon may use. */
export const DOCS_ICON_ELEMENTS = [
  "path",
  "circle",
  "rect",
  "line",
  "ellipse",
  "polyline",
  "polygon",
] as const;

export type DocsIconElement = (typeof DOCS_ICON_ELEMENTS)[number];

/** The attributes an icon element may set. Stroke and color come from the frame. */
export const DOCS_ICON_ATTRIBUTES = [
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "width",
  "height",
  "points",
  "fill",
] as const;

export type DocsIconAttribute = (typeof DOCS_ICON_ATTRIBUTES)[number];

export type DocsIconNode = readonly (readonly [
  DocsIconElement,
  Readonly<Partial<Record<DocsIconAttribute, string>>>,
])[];

/** The full Lucide set, as `generated/lucide-icons.ts` stores it. */
export interface LucideIconData {
  icons: Readonly<Record<string, DocsIconNode>>;
  /** Old names of renamed icons, to their current names. */
  aliases: Readonly<Record<string, string>>;
}
