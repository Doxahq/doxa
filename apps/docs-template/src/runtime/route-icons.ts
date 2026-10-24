import {
  coreIconNode,
  docsIconKey,
  type DocsIconNode,
} from "@doxahq/docs-prose/icons";
import type { RuntimeMdxNode } from "@doxahq/mdx-runtime";

import type { ParsedDocument } from "./docs-route-data";
import type { RuntimeNavNode } from "./runtime-source";

/**
 * The glyphs of the icons a route draws, by the icon key the route uses.
 *
 * The renderer bundles only the suggested icons (`CORE_ICON_NODES`). Any
 * other Lucide icon travels in the route data, so a page ships only the
 * glyphs it shows: the server draws them, the browser hydrates them, and a
 * client navigation gets them with the rest of the route.
 */
export type RouteIcons = Readonly<Record<string, DocsIconNode>>;

interface RouteIconSources {
  sectionNavigation: readonly RuntimeNavNode[];
  runtimeDocument: ParsedDocument | null;
}

/**
 * The icon keys a route draws that the bundled core set lacks: page icons in
 * the sidebar, and `icon` props in the page content (cards).
 */
export function collectRouteIconKeys(route: RouteIconSources): string[] {
  const keys = new Set<string>();
  const add = (name: unknown) => {
    if (typeof name !== "string") return;
    const key = docsIconKey(name);
    if (key && !coreIconNode(key)) keys.add(key);
  };

  const visitNavigation = (nodes: readonly RuntimeNavNode[]) => {
    for (const node of nodes) {
      if (!("href" in node)) continue;
      add(node.icon);
      if (node.items) visitNavigation(node.items);
    }
  };
  visitNavigation(route.sectionNavigation);

  const visitContent = (nodes: readonly RuntimeMdxNode[]) => {
    for (const node of nodes) {
      if (node.type !== "element") continue;
      add(node.props?.icon);
      if (node.children) visitContent(node.children);
    }
  };
  if (route.runtimeDocument?.ok) {
    visitContent(route.runtimeDocument.document.nodes);
  }

  return [...keys].sort();
}

/**
 * Looks up the glyphs for a route's icons. Unknown names are left out, and
 * the result is undefined when the route needs no glyph beyond the core set.
 * The full Lucide set loads on first use, on the server only.
 */
export async function loadRouteIcons(
  route: RouteIconSources
): Promise<RouteIcons | undefined> {
  const keys = collectRouteIconKeys(route);
  if (keys.length === 0) return undefined;

  const { lucideIconNode } = await import("@doxahq/docs-prose/icons/lucide");
  const icons: Record<string, DocsIconNode> = {};
  for (const key of keys) {
    const node = lucideIconNode(key);
    if (node) icons[key] = node;
  }
  return Object.keys(icons).length > 0 ? icons : undefined;
}
