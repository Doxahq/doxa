import { createContext, useContext, type ReactNode } from "react";
import { getDocsRouteDataFromMatches } from "@/src/runtime/docs-route-data";
import type { RouteIcons } from "@/src/runtime/route-icons";
import type { IconComponent } from "@doxahq/docs-prose";
import {
  CORE_ICON_NODES,
  coreIconNode,
  docsIconKey,
  DocsIconSvg,
} from "@doxahq/docs-prose/icons";
import { useRouterState } from "@tanstack/react-router";

const RouteIconsContext = createContext<RouteIcons | undefined>(undefined);

/**
 * Shares the current route's icon glyphs with every `DocsIcon` on the page:
 * the sidebar, the mobile menu in the navbar, and the cards in the content.
 */
export function RouteIconsProvider({ children }: { children: ReactNode }) {
  const icons = useRouterState({
    select: (state) => getDocsRouteDataFromMatches(state.matches)?.icons,
  });
  return (
    <RouteIconsContext.Provider value={icons}>
      {children}
    </RouteIconsContext.Provider>
  );
}

/**
 * A page or card icon, by any Lucide name. Suggested icons are bundled. Any
 * other icon comes with the route data, so the server and the browser draw
 * the same glyph. An unknown name draws nothing.
 */
export function DocsIcon({
  name,
  className,
}: {
  name: string | null | undefined;
  className?: string;
}) {
  const routeIcons = useContext(RouteIconsContext);
  const key = docsIconKey(name);
  const node = key ? (routeIcons?.[key] ?? coreIconNode(key)) : null;
  return node ? <DocsIconSvg node={node} className={className} /> : null;
}

const iconComponents = new Map<string, IconComponent>();

/**
 * The card icon component for a name, for `createProseComponents`. The same
 * name always gets the same component, so a card does not remount its icon.
 */
export function resolveDocsIcon(name: string): IconComponent | null {
  const key = docsIconKey(name);
  if (!key) return null;
  let component = iconComponents.get(key);
  if (!component) {
    component = function CardIcon({ className }: { className?: string }) {
      return <DocsIcon name={key} className={className} />;
    };
    iconComponents.set(key, component);
  }
  return component;
}

export function ExternalLinkIcon({ className }: { className?: string }) {
  return (
    <DocsIconSvg node={CORE_ICON_NODES.arrowUpRight} className={className} />
  );
}
