/**
 * The full Lucide set. About 90 KB gzipped: import it on the server, or with
 * a dynamic `import()` in the browser.
 */
import LUCIDE_ICON_DATA from "./generated/lucide-icons";
import { docsIconKey } from "./names";
import type { DocsIconNode } from "./node";

export { LUCIDE_ICON_DATA };

/** Every current icon name, in alphabetical order. Old names are left out. */
export const LUCIDE_ICON_NAMES: readonly string[] = Object.keys(LUCIDE_ICON_DATA.icons);

/** The current name of an icon, or null when Lucide has no such icon. Follows renames. */
export function lucideIconName(name: string | null | undefined): string | null {
  const key = docsIconKey(name);
  if (!key) return null;
  if (LUCIDE_ICON_DATA.icons[key]) return key;
  const renamed = LUCIDE_ICON_DATA.aliases[key];
  return renamed && LUCIDE_ICON_DATA.icons[renamed] ? renamed : null;
}

/** An icon by any name form a page may store, or null when Lucide has no such icon. */
export function lucideIconNode(name: string | null | undefined): DocsIconNode | null {
  const current = lucideIconName(name);
  return current ? LUCIDE_ICON_DATA.icons[current]! : null;
}
