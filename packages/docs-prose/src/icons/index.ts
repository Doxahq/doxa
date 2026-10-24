/**
 * Docs icons: every Lucide icon, drawn the same in the published docs and in
 * the dashboard editor.
 *
 * This entry is small and safe to import eagerly: the drawing component, the
 * name helpers, and the suggested icons. The full set is a separate entry,
 * `@doxahq/docs-prose/icons/lucide` (about 90 KB gzipped). Load it on the
 * server or lazily, never in a page's first bundle. Search words for the icon
 * picker are in `@doxahq/docs-prose/icons/lucide-tags`.
 */
export { DocsIconSvg, type DocsIconSvgProps } from "./docs-icon-svg";
export { DOCS_ICON_NAME_PATTERN, docsIconKey, docsIconLabel } from "./names";
export {
  DOCS_ICON_ATTRIBUTES,
  DOCS_ICON_ELEMENTS,
  type DocsIconAttribute,
  type DocsIconElement,
  type DocsIconNode,
  type LucideIconData,
} from "./node";
export {
  CORE_ICON_CURRENT_NAMES,
  CORE_ICON_NODES,
  LUCIDE_ICON_COUNT,
  LUCIDE_VERSION,
  SUGGESTED_ICON_NAMES,
} from "./generated/lucide-core";

import { CORE_ICON_NODES } from "./generated/lucide-core";
import { docsIconKey } from "./names";
import type { DocsIconNode } from "./node";

/** A suggested icon, by any name form a page may store, or null. */
export function coreIconNode(name: string | null | undefined): DocsIconNode | null {
  const key = docsIconKey(name);
  return key ? (CORE_ICON_NODES[key] ?? null) : null;
}
