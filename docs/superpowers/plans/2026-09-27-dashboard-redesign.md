# Dashboard redesign (frontend only)

Status: implemented on 2026-09-27 (phases 1–5). See section 13 for what differs from this spec. Phase 1 (MDX formatter) is a
separate change from the redesign. Visual reference:
`design-reference/doxa-prototype.html` (static mock; do not import or ship it).

## 1. Goal

Move the Doxa dashboard from a workspace layout with top project tabs to a
project-first layout: one sidebar with sliding views (Project, Content, Site
settings), a top bar with the editor controls, and a Notion-style page editor.
The look stays the same: near-black, 0px radius, hairline borders, mono labels,
blue accent.

## 2. Hard rules

1. The redesign changes only `apps/web`. It does not change API routes, the
   database, auth, jobs, the generation pipeline, Doxabot, publishing, or the
   MDX render pipeline. Phase 1 is the only change outside `apps/web`, and it is
   a separate, reviewed change.
2. Data contracts do not change: request and response shapes, stored MDX, URLs
   that other systems use, and environment config.
3. Every button, menu item, and indicator calls functionality that exists
   today. If a design element needs a missing capability, leave it out or show
   it disabled with a "Coming soon" tooltip (see section 9).
4. Every existing behavior keeps working: save, autosave, publish, revert page,
   discard all changes, branch switch, create, manage, sync and history,
   project switch, project creation, page and section structure edits,
   generations, domains, Doxabot, generation cache, preview access, and site
   settings.
5. The MDX preview renderer does not change. The redesign only puts it in a
   new frame.
6. If a change can touch core behavior, stop and ask.

## 3. Decisions

| Topic | Decision |
|---|---|
| Write mode editor | TipTap v3 (MIT). All used packages are MIT on the public npm registry, including `@tiptap/extension-drag-handle(-react)`, `@tiptap/extension-node-range` and `@tiptap/extension-unique-id`. No TipTap paid service is used. |
| Code editing | CodeMirror stays for all code editing: MDX mode and the site settings JSON tab. It gets the new styling only. |
| MDX output of Write mode | Untouched top-level blocks are written back byte-for-byte. Edited blocks are written with the shared `formatMdx()` style (Phase 1). |
| Agent output | The agent formats every page with the same `formatMdx()` before validation (Phase 1). |
| Site settings mapping | Appearance = Branding + Theme. Navigation = Navbar + Footer. Domains = the current project Domains page. SEO & sharing = SEO. Features = Features. Advanced (JSON) = the JSON tab. |
| Doxabot | Moves into project Settings, with the generation cache and preview access cards. |
| Landing | `/dashboard` redirects to the last opened project (localStorage) or the first project. With no projects, it shows the existing new project flow. |

## 4. Phase 1: shared MDX formatter

### 4.1 What it does

`formatMdx(source: string): string`, exported from `@doxahq/mdx-runtime/format`
(a separate entry, so the docs renderer bundle does not grow).

- Keeps the frontmatter text exactly as it is.
- Parses the body with the renderer's stack: `remark-parse`, `remark-mdx`,
  `remark-gfm`.
- Writes the body with `remark-stringify` in the style that generated pages
  use today (measured on the 19 fixture pages):
  - `-` bullets, `1.` ordered lists, `**strong**`, `_emphasis_`
  - backtick fences, `#` headings (no setext), `---` rules
  - double quotes in component attributes
- Keeps the original text of any top-level block that contains a JavaScript
  expression, an `import`/`export`, or raw HTML. Example: `<Mermaid chart={`…`}>`.
  The serializer removes indentation inside template strings, which changes the
  value a component receives.
- Returns the input unchanged when the body does not parse. Validation then
  reports the error as it does today.

### 4.2 Guarantees (tests)

- Render parity: for every fixture page, `parseRuntimeMdx(page)` and
  `parseRuntimeMdx(formatMdx(page))` give deep-equal documents. The fixture sets
  are read only.
- Idempotence: `formatMdx(formatMdx(x)) === formatMdx(x)`.
- Invalid MDX comes back unchanged.
- Expression blocks come back byte-for-byte.

### 4.3 Agent hook

`packages/agent/src/doxa-agent/writer-pipeline.ts`, in `composeFinal`: format the
composed page before `validatePage`. Both exits of the writer (first-pass accept
and degraded accept) go through `composeFinal`, so generation and Doxabot
updates both get the formatter. Existing published pages are not rewritten in
bulk. A page gets the style the next time a writer produces it.

## 5. Layout

- Sidebar 272px, top bar 52px, status bar at the bottom.
- The workspace sidebar (Overview, Projects) and the project tab row are
  removed. All project navigation is in the sidebar.
- Status bar: path on the left. Branch and system status on the right.

### 5.1 Sidebar header (all views)

Logo, project switcher, collapse button (⌘/Ctrl+\\). "Go to" box (⌘/Ctrl+K)
opens the existing command menu. In the Content view it focuses page search.

### 5.2 Sliding views

Order: Project → Content → Site settings. 340ms,
`cubic-bezier(0.22,0.8,0.2,1)` with a fade. Only the two views in a transition
animate. Hidden views are `inert`.

- **Project view:** Overview, Content (edited-page count badge and chevron),
  Generations (latest status when cancelled or failed), Settings. Footer: Site
  settings button, user row (avatar, email, GitHub and docs icon buttons).
- **Content view:** back arrow and CONTENT label, branch switcher card, Pages
  section (edited badge, new page button, "Find a page" with the "/" shortcut),
  page tree. The page tree reuses `content-page-tree.tsx` and its structure
  actions, restyled.
- **Site settings view:** back arrow (and Esc) returns to the previous view.
  Site card (accent swatch, site name, live domain). Items with a current value
  on the right:

  | Item | Value shown | Source |
  |---|---|---|
  | Appearance | accent swatch and default mode | `theme.primary`, `theme.defaultMode` |
  | Navigation | number of navbar links | `navbar.links` |
  | Domains | green dot and "live" when a domain is active | `useProjectDomains` |
  | SEO & sharing | number of keywords | `seo.keywords` |
  | Features | none | — |
  | Advanced (JSON) | none | — |

  Footer note: "Site changes go live with your next publish."

### 5.3 Project switcher

Monogram (initial and a color derived from the project name, frontend only),
name, repository, chevrons. Dropdown with search, project rows (domain, LIVE or
DRAFT from the publication state, check on the current one), and "New project",
which opens the existing `/dashboard/projects/new` flow. ⌘/Ctrl+P, arrows,
Enter, Esc.

### 5.4 Branch switcher

Card with branch name, LIVE tag on main, DRAFT tag when the branch has
unpublished changes, and one status line from `useBranchStatus`
(`changeCount`, `behind`). Dropdown with search and branch rows. It keeps the
existing actions: create branch, manage branches, history. "Compare" opens the
existing sync view. "Merge into main" opens the existing publish flow for a
named branch. ⌘/Ctrl+B.

### 5.5 Top bar

- Left: sidebar toggle, breadcrumb (section / group / page), save state
  ("Saving…" muted, "● Saved" green).
- Right, Content view only:
  - Mode switch: Write | Split | MDX (⌘/Ctrl+1–3). The preview-only mode is
    removed.
  - Focus mode (⌘/Ctrl+.): hides the sidebar and the outline.
  - Publish with the changed-page count. The popover shows the target domain,
    the branch, and the changed pages. "Review changes" and "Publish" open the
    existing `PublishDialog`, so sync checks, conflicts and branch cleanup work
    as today.
  - More menu. THIS PAGE: open page on the live site, open branch preview (the
    existing preview link), revert page. SITE: open published docs, copy site
    URL. Then "Discard all changes" in red, which opens the existing dialog.
- Other views: More menu with the SITE group only.

## 6. Editor

### 6.1 Write mode (TipTap)

- Page padding 56px top. Title 40px bold, description 17px muted (both from
  frontmatter). Properties row: SLUG, STATUS, VERSION. Column max 720px, body
  16px/1.75, H2 24px, H3 18.5px. "On this page" outline on the right (200px,
  sticky, hidden under 1240px).
- Slash menu, markdown shortcuts, hover gutter with + and drag handle,
  selection toolbar (Bold, Italic, Strike, Code, Link, H2), caret and selection
  in the accent color.
- Supported blocks: paragraph, H2, H3, bulleted and numbered lists, code block,
  `Note` (callout), `CardGrid` with `Card`, divider. Every other top-level block
  (`Step`, `Tabs`, `FileTree`, `Mermaid`, `Api*`, tables, expressions,
  imports) is a locked block: it renders with the existing preview components
  and opens its source in a small CodeMirror editor. Its text is never
  rewritten unless the user edits that source.
- Load and save: the editor reads `state.text` and writes through
  `state.setText()`, so `use-draft-buffer` autosave, save, revert, discard and
  publish do not change. Frontmatter keys other than `title` and `description`
  are kept as they are.
- Tests:
  - Open and save every fixture page with no edit: output is byte-identical.
  - Edit one block: only that block's text changes.

### 6.2 Split mode

Write editor on the left. On the right, the existing `MdxPreview` inside a
browser frame: three dots, public URL (domain muted, path in body color), open
in a new tab. No site header or navigation inside. Stacked on mobile.

### 6.3 MDX mode

The existing CodeMirror editor, restyled: surface background, border, max
880px, a short note and a Copy button. Same behavior as today.

## 7. Project pages

- Overview: current project details (status, repository, current branch, docs
  target, latest generation) as a card with label/value rows.
- Generations: current list as a card with rows (status badge, generation ID,
  time, duration) and the existing "Generate docs" action. The list API has no
  commit hash, so rows do not show one.
- Settings: Doxabot, generation cache, and preview access, restyled. The spec
  mentions name, repository and a danger zone, but those settings do not exist
  today, so they are not added.

## 8. Visual tokens

Tokens stay in `apps/web/src/styles/globals.css`. New tokens for this phase:
`faint` #5c5c66, `menu` #141416, `menu-border` #2e2e33, `danger` #f87171, and
`primary-wash` 0.09. Hover fills only on elements that do something on click
(see `apps/web/DESIGN.md`). `DESIGN.md` and the web section of `AGENTS.md` are
updated with the new shell.

## 9. Not built (no backing functionality)

| Design element | Handling |
|---|---|
| Duplicate page, Copy block link | Left out |
| "Ask AI" in the selection toolbar | Left out |
| Image block (no page image upload API) | Left out of the slash menu |
| Per-page "Updated" time (pages have no timestamp) | Left out of the properties row |
| Page counts per project in the switcher | Left out |
| User plan in the user row (plan is per project) | Left out |
| Commit hash in the generations list | Left out |
| SEO "indexed / hidden" value | Replaced by the keyword count |
| Select pages to publish (publish is per branch) | Plain list, no checkboxes |

## 10. Responsive

Under 820px: the sidebar becomes a drawer, mode labels become icons, the
outline and gutter are hidden, card grids use one column, settings rows stack.

## 11. Phases

1. Shared `formatMdx()` and the agent hook (section 4). Separate review.
2. Shell: tokens, routing and landing, sidebar view stack, project switcher,
   top bar, status bar. The editor stays CodeMirror during this phase.
3. Site settings as pages, project Settings merge, Overview and Generations.
4. Write mode (TipTap), Split frame, MDX mode restyle.
5. Responsive pass, contrast check, docs update, final report.

Each phase ends with typecheck, tests, build, and a browser check on the fixture
server described in the project memory.

## 12. Files

- **Phase 1:** `packages/mdx-runtime/{src/format.ts, tsup.config.ts,
  package.json}`, new tests in `packages/mdx-runtime`,
  `packages/agent/src/doxa-agent/writer-pipeline.ts`, `docs/current/` (new
  formatter page).
- **Phases 2–5, changed:**
  - `apps/web/src/routes/dashboard/{route,index}.tsx`, `projects/$projectId/*`
  - `components/dashboard/{dashboard-layout, app-sidebar, dashboard-header,
    project-workspace-layout, status-bar, command-menu, user-menu,
    project-overview-page, project-generations-page, project-settings-page,
    project-doxabot-page, project-domains-page}.tsx`
  - `components/dashboard/content/**`, including the site-settings tabs
  - `lib/dashboard/sidebar-panel-context.tsx`, `styles/globals.css`,
    `DESIGN.md`, `AGENTS.md`
- **Phases 2–5, new:**
  - `components/dashboard/shell/*`: sidebar views, switchers, top bar
  - `components/dashboard/editor/*`: TipTap editor, MDX bridge, blocks
  - `lib/dashboard/use-last-project.ts`

No file under `apps/api`, `packages/db`, `packages/contracts`,
`apps/docs-template`, `apps/docs-runtime`, or the fixture sets changes in any
phase.

## 13. Implementation notes

- CodeMirror stays for all code editing (decided after this spec was written).
- Page search in the sidebar shows a flat list of matches. It does not yet
  filter the tree in place and expand the matching groups.
- One-line cards (`<Card …>text</Card>`) that share a paragraph are kept
  together when a card group is saved, so their layout does not change.
- `site-settings-dialog.tsx` and `ProjectsBackNavigation` are no longer used by
  the dashboard. They stay until their tests are moved or removed, which needs
  a separate decision.
- The Write editor chunk is about 190 KB gzip. It includes `yjs`, which the
  drag handle requires as a peer, and it loads only on the content route.
