import { z } from "zod";

/**
 * Where the docs sidebar sits on a window wider than the page column.
 *
 * - `beside-content`: the sidebar sits next to the text, in a page column
 *   capped at 1440px and centered in the window.
 * - `page-edge`: the page column fills the window. The sidebar sits at its
 *   left edge, the table of contents at its right edge, and the text is
 *   centered between them.
 */
export const SIDEBAR_POSITIONS = ["beside-content", "page-edge"] as const;
export type SidebarPosition = (typeof SIDEBAR_POSITIONS)[number];

export const layoutSchema = z
  .object({
    sidebar: z.enum(SIDEBAR_POSITIONS).default("beside-content"),
    /**
     * The sidebar's groups (a heading and the pages under it) collapse and
     * expand from their heading. They all start expanded.
     */
    collapsibleGroups: z.boolean().default(false),
  })
  .strict();

export type ResolvedLayout = z.output<typeof layoutSchema>;

/** Every layout value at its default: the same as a config without `layout`. */
export const DEFAULT_LAYOUT: ResolvedLayout = {
  sidebar: "beside-content",
  collapsibleGroups: false,
};

interface LayoutConfig {
  layout?: Partial<ResolvedLayout>;
}

/** The sidebar position of a config. A config without `layout` keeps the default. */
export function sidebarPosition(config: LayoutConfig): SidebarPosition {
  return config.layout?.sidebar ?? DEFAULT_LAYOUT.sidebar;
}

/**
 * Where the section tabs sit (the links between top-level docs sections).
 *
 * - `below-navbar`: a tab bar under the top bar.
 * - `in-navbar`: the tabs fill the center of the top bar, and the search box
 *   moves to its right side, next to the other buttons.
 *
 * It is not a config field yet. It follows the sidebar position: "Page edge"
 * puts the tabs in the top bar. Themes will be able to choose it later; read
 * it only through `docsLayout`, so they can plug in there.
 */
export const SECTION_TABS_PLACEMENTS = ["below-navbar", "in-navbar"] as const;
export type SectionTabsPlacement = (typeof SECTION_TABS_PLACEMENTS)[number];

export interface DocsLayout extends ResolvedLayout {
  sectionTabs: SectionTabsPlacement;
}

/** The docs page layout of a config: the one place that resolves it. */
export function docsLayout(config: LayoutConfig): DocsLayout {
  const sidebar = sidebarPosition(config);
  return {
    sidebar,
    collapsibleGroups:
      config.layout?.collapsibleGroups ?? DEFAULT_LAYOUT.collapsibleGroups,
    sectionTabs: sidebar === "page-edge" ? "in-navbar" : "below-navbar",
  };
}
