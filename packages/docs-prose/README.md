# @doxahq/docs-prose

Shared prose rendering for Doxa documentation pages.

One MDX node walk, one prose component set, one article typography class, one
stylesheet. Used by the published docs renderer (`apps/docs-template`) and by
the dashboard content editor preview (`apps/web`), so a page looks the same
while it is edited as it does after it is published.

## What lives here

| Export | Purpose |
| --- | --- |
| `RuntimeMdxContent` | Renders a parsed MDX document |
| `createProseComponents` | Builds the component map |
| `ARTICLE_PROSE_CLASS` | Typography for an article body |
| `Note`, `Card`, `CardGrid`, `Step`, `StepItem`, `ProseLink` | The shared components |
| `createFileTree` | `<FileTree>` built around a host's icon set |
| `createPre` | The code fence wrapper (language label, copy button) around a host's icon set |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | The page tab set |
| `createMermaid` | `<Mermaid>` built around the host's `mermaid` module, which the host loads lazily |
| `loadProseHighlighter` | The Shiki instance used for code fences, loaded on demand |
| `tocTriggers`, `activeTocIndex`, `tocScrollTargets` | The current heading of a table of contents, including short sections at the end of a page |
| `DOCS_ICON_NAMES`, `isDocsIconName` | The suggested page icons, which the generation agent picks from |
| `@doxahq/docs-prose/icons` | `DocsIconSvg`, the name helpers, and the suggested icons as data (small, eager) |
| `@doxahq/docs-prose/icons/lucide` | Every Lucide icon as data, and old names of renamed icons (about 90 KB gzipped: server or lazy only) |
| `@doxahq/docs-prose/icons/lucide-tags` | Search words for every Lucide icon, for an icon picker (lazy only) |
| `isComponentOnlyParagraph`, `unwrapComponentParagraph` | Node normalization |
| `@doxahq/docs-prose/styles.css` | Prose rules layered on `@tailwindcss/typography` |

Nothing here imports from an application. Routing, icons, the `mermaid`
module, and API reference blocks are injected by the host.

## Icons

A page or card can use any Lucide icon, by its camelCase name (`bookOpen`).
Icons are data (`DocsIconNode`: the SVG elements of the 24×24 frame), drawn by
`DocsIconSvg` from an allowlist of elements and attributes, never from markup.
The published docs and the dashboard draw the same data, so an icon looks the
same in the editor and on the site.

- The suggested icons (`DOCS_ICON_NAMES`) are in the small core set
  (`CORE_ICON_NODES`), which hosts bundle.
- The full set is a separate entry. The docs renderer reads it on the server
  and sends each route the glyphs it uses. The dashboard loads it lazily.
- Lucide renames icons over time. The data keeps the old names as aliases, so
  a stored name keeps its icon.
- The generation agent picks page icons from the same set. The script also
  writes `packages/agent/runtime/lucide-icons.json` (names, search words and
  aliases, no glyphs), which ships beside the agent bundle.

The data is generated from the pinned `lucide-static` and
`@iconify-json/lucide` dev dependencies:

```sh
pnpm --filter @doxahq/docs-prose generate:icons
```

To upgrade Lucide, change the two versions and run the script. The script
fails if the new version drops a name that pages can store: add an alias to
`EXTRA_ALIASES` in `scripts/generate-lucide-icons.mjs`. Lucide is ISC
licensed, with some icons under MIT. The license text ships with the data in
`src/icons/generated/LUCIDE_LICENSE.txt`. Keep it there.

## Using it

```ts
export const components = createProseComponents({
  link: RoutedLink,
  resolveIcon: resolveDocsIcon, // name => icon component, or null
  overrides: { pre: HighlightedPre, Tabs, TabsList, TabsTrigger, TabsContent },
});
```

`overrides` is how a host extends the map. Add a component there rather than
editing this package.

To highlight code fences, pass the shared instance to the parser and wrap the
rendered output in `.prose-content`, which the code-block rules are scoped to:

```ts
const document = parseRuntimeMdx(source, { highlighter: await loadProseHighlighter() });
```

`RuntimeMdxContent` throws on a component name the map does not carry, which is
correct for a build-time renderer. A live editor passes `fallbackComponent` so a
missing entry renders a placeholder instead of blanking the page.

## Host setup

An application that renders prose must do three things in its stylesheet:

```css
@plugin "@tailwindcss/typography";
@import "@doxahq/docs-prose/styles.css";
/* Tailwind does not scan node_modules, so point it at this package. */
@source "../../../../packages/docs-prose/src";
```

Without the `@source` line the shared components render unstyled, because their
class names never reach the host's Tailwind build.

It must also define the inline-code chip tokens, or the chip falls back to
`--muted` and `--border` and reads differently from the published page:

```css
--code-bg: oklch(0.25 0 0);
--code-fg: oklch(0.8 0 0);
--code-border: oklch(0.35 0 0);
```

The inline-code font stack is pinned by the stylesheet rather than taken from
the host's `--font-mono`, because the two applications register different ones.
Override it with `--prose-code-font` if a host needs a different face.

## Tests

`pnpm --filter @doxahq/docs-prose test` renders real MDX through the package and
asserts the output, including the paragraph normalization that keeps `<Step>`
numbering correct.
