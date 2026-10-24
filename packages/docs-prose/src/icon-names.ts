/**
 * The suggested docs icons.
 *
 * A page can use any Lucide icon (see `./icons`). These are the ones the
 * generation agent picks from and the icon picker shows first. Their glyphs
 * are in the small core set, so they draw on the first frame in every host.
 *
 * Generated pages store these exact names, so never remove one. Two are old
 * Lucide names (`alignJustify`, `circleHelp`) that the icon data maps to the
 * current icons.
 *
 * Keep this in step with `apps/docs-template/src/schemas/icons.schema.json`,
 * which is what the agent is allowed to choose from. After a change, run
 * `pnpm --filter @doxahq/docs-prose generate:icons`.
 */
export const DOCS_ICON_NAMES = [
  "alignJustify",
  "arrowUpRight",
  "beaker",
  "book",
  "bookOpen",
  "box",
  "circleHelp",
  "code",
  "cog",
  "compass",
  "database",
  "file",
  "flag",
  "folder",
  "globe",
  "house",
  "key",
  "layers",
  "list",
  "package",
  "play",
  "plug",
  "rocket",
  "search",
  "server",
  "settings",
  "shield",
  "terminal",
  "wrench",
  "zap",
] as const;

export type DocsIconName = (typeof DOCS_ICON_NAMES)[number];

const docsIconNameSet: ReadonlySet<string> = new Set(DOCS_ICON_NAMES);

export function isDocsIconName(value: string | undefined | null): value is DocsIconName {
  return typeof value === "string" && docsIconNameSet.has(value);
}
