---
name: Doxa Web
version: alpha
description: >-
  Design system for the Doxa platform web app (apps/web): a brutalist-dark
  foundation with an e2b.dev-inspired dashboard layout on Doxa's blue brand.
  Tokens mirror apps/web/src/styles/globals.css (the runtime source of truth).
colors:
  background: "#0b0b0c"
  foreground: "#f4f4f5"
  body: "#dcdce0"
  prose: "#dfdfe3"
  card: "#101012"
  card-foreground: "#f4f4f5"
  card-highlight: "rgb(255 255 255 / 0.03)"
  surface-hover: "#141417"
  popover: "#101012"
  popover-foreground: "#f4f4f5"
  primary: "#3d8bff"
  dashboard-primary: "#3d8bff"
  primary-foreground: "#f4f4f5"
  primary-text: "#6aa6ff"
  primary-wash: "rgb(61 139 255 / 0.08)"
  secondary: "#18181b"
  secondary-foreground: "#dcdce0"
  muted: "#1c1c20"
  muted-foreground: "#a1a1aa"
  label: "#8e8e98"
  accent: "#141417"
  accent-foreground: "#f4f4f5"
  destructive: "oklch(0.577 0.245 27.325)"
  destructive-foreground: "oklch(0.985 0 0)"
  success: "#4ade80"
  success-foreground: "#0b0b0c"
  warning: "#fbbf24"
  warning-foreground: "#0b0b0c"
  border: "#26262a"
  divider: "#1c1c20"
  input: "#26262a"
  input-background: "#111113"
  ring: "#3d8bff"
  editor: "#0f0f11"
  code: "#161619"
  selection: "rgb(61 139 255 / 0.3)"
  sidebar: "#080809"
  sidebar-foreground: "#dcdce0"
  sidebar-primary: "#3d8bff"
  sidebar-primary-foreground: "#f4f4f5"
  sidebar-accent: "rgb(255 255 255 / 0.04)"
  sidebar-accent-foreground: "#f4f4f5"
  sidebar-border: "#26262a"
  scrollbar-thumb: "#26262a"
  scrollbar-thumb-hover: "#3a3a40"
typography:
  display:
    fontFamily: "Sora, sans-serif"
    fontSize: "3rem"
    fontWeight: 700
    lineHeight: "1"
    letterSpacing: "-0.02em"
  page-title:
    fontFamily: "JetBrains Mono, monospace"
    fontSize: "0.875rem"
    fontWeight: 700
    lineHeight: "1.2"
    letterSpacing: "0.14em"
  section-label:
    fontFamily: "JetBrains Mono, monospace"
    fontSize: "0.875rem"
    fontWeight: 700
    lineHeight: "1.4"
    letterSpacing: "0.12em"
  section-description:
    fontFamily: "Inter, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.5"
  nav-label:
    fontFamily: "JetBrains Mono, monospace"
    fontSize: "0.625rem"
    fontWeight: 400
    lineHeight: "1.4"
    letterSpacing: "0.16em"
  body:
    fontFamily: "Inter, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.5"
  body-sm:
    fontFamily: "Inter, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: "1.5"
  button:
    fontFamily: "Inter, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: "1"
  stat-value:
    fontFamily: "JetBrains Mono, monospace"
    fontSize: "1.875rem"
    fontWeight: 700
    lineHeight: "1.1"
  badge:
    fontFamily: "JetBrains Mono, monospace"
    fontSize: "0.625rem"
    fontWeight: 500
    lineHeight: "1"
    letterSpacing: "0.14em"
  terminal:
    fontFamily: "JetBrains Mono, monospace"
    fontSize: "0.6875rem"
    fontWeight: 400
    lineHeight: "1.4"
rounded:
  sm: "0px"
  DEFAULT: "0px"
  md: "0px"
  lg: "2px"
  xl: "4px"
  full: "9999px"
spacing:
  unit: "4px"
  page-padding: "1.5rem"
  content-max-width: "48rem"
  sidebar-width: "326px"
  header-height: "3.25rem"
  status-bar-height: "2rem"
  control-height: "2.25rem"
utilities:
  scrollbar-subtle:
    width: "thin / 6px"
    track: "transparent"
    thumb: "scrollbar-thumb"
    thumb-hover: "scrollbar-thumb-hover"
    rounded: "0px"
components:
  button-primary:
    backgroundColor: "foreground"
    textColor: "background"
    typography: "button"
    rounded: "DEFAULT"
    height: "2.25rem"
    padding: "0 1rem"
  button-outline:
    backgroundColor: "card"
    textColor: "foreground"
    border: "1px solid var(--border)"
    typography: "button"
    rounded: "DEFAULT"
    height: "2.25rem"
    padding: "0 1rem"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "muted-foreground"
    typography: "button"
    rounded: "DEFAULT"
    height: "2.25rem"
    padding: "0 1rem"
  sidebar:
    backgroundColor: "sidebar"
    textColor: "sidebar-foreground"
    width: "16rem"
    border: "1px solid var(--sidebar-border)"
  sidebar-item:
    textColor: "sidebar-foreground"
    typography: "body-sm"
    rounded: "DEFAULT"
  sidebar-item-active:
    backgroundColor: "secondary"
    textColor: "foreground"
    typography: "body-sm"
  command-box:
    backgroundColor: "sidebar"
    textColor: "muted-foreground"
    border: "1px solid var(--sidebar-border)"
    typography: "body-sm"
    height: "2rem"
  page-header:
    backgroundColor: "background"
    textColor: "foreground"
    typography: "page-title"
    height: "3.5rem"
    border: "1px solid var(--border)"
  page-body:
    width: "48rem"
  section-label:
    textColor: "foreground"
    typography: "section-label"
  section-description:
    textColor: "muted-foreground"
    typography: "section-description"
  field-row:
    textColor: "foreground"
    typography: "body"
    padding: "1rem 1.25rem"
    border: "1px solid var(--divider)"
    labelColumn: "200px"
  table-header:
    textColor: "muted-foreground"
    typography: "section-label"
  empty-state:
    backgroundColor: "card"
    textColor: "foreground"
    border: "1px solid var(--border)"
    typography: "page-title"
    rounded: "DEFAULT"
    padding: "3rem 2rem"
  status-bar:
    backgroundColor: "sidebar"
    textColor: "muted-foreground"
    typography: "terminal"
    height: "2rem"
    border: "1px solid var(--border)"
  badge-success:
    backgroundColor: "success/8"
    border: "1px solid success/35"
    textColor: "success"
    typography: "badge"
    rounded: "DEFAULT"
  badge-muted:
    backgroundColor: "transparent"
    textColor: "muted-foreground"
    typography: "badge"
    rounded: "DEFAULT"
  input:
    backgroundColor: "input-background"
    textColor: "foreground"
    border: "1px solid var(--input)"
    typography: "body"
    rounded: "DEFAULT"
    height: "2.25rem"
---

## Overview

Doxa's web app pairs a **brutalist-dark foundation** with an **e2b.dev-inspired
dashboard layout**, expressed through Doxa's **blue** brand. The feeling is
precise, technical, and calm: pure-black canvas, hairline borders, sharp corners
(zero radius), monospace structure labels, and a sentence-case sans body. Colour
is scarce on purpose — blue marks focus/identity and green marks "live", so the
few accents that appear carry real meaning.

Two surfaces share one token system:

- **Marketing** (`/`, `/pricing`, `/mcp`, `/about`, `/changelog`;
  `components/marketing/**`) — the v11 site from the Claude Design canvas: a
  black ground, Geist Mono display, Geist body, JetBrains Mono labels, a
  centred 1200px column with dashed guide lines and "+" joints, the WebGL
  aurora hero, and animated box bands. It has its own plain CSS in
  `src/styles/marketing/` (one shared file plus one file per page, each scoped
  to `.pg--<page>`), loaded only by the `_marketing` layout route. It does not
  use the dashboard tokens; see "Marketing site" below.
- **Dashboard** (`/dashboard/**`) — the e2b-style product app: a fixed left
  sidebar, a sticky page top bar, **content centred in a constrained column**,
  and a terminal status bar pinned to the bottom.

The runtime source of truth for tokens is `apps/web/src/styles/globals.css`
(Tailwind v4 `@theme inline`). This file is the *design* source of truth; keep
the two in sync. When they disagree, globals.css wins for values and this file
wins for intent.

## Colors

A near-black canvas with a faint cool cast. Pure black and pure white are not
used: both cause halation in long reading and writing sessions. Surfaces step
up in lightness: `sidebar` (#080809) → `background` (#0b0b0c) → `editor`
(#0f0f11) → `card` (#101012) → `surface-hover` (#141417) → `code` (#161619).
Lines: `divider` (#1c1c20) between rows inside a card, `border` (#26262a) for
main hairlines. Text has four steps: `foreground` (#f4f4f5) for titles and
values, `body` (#dcdce0) for body and nav text, `muted-foreground` (#a1a1aa) for
descriptions, and `label` (#8e8e98) for uppercase mono labels. Each text step
passes 4.5:1 on `card`.

- **Primary — blue** (`primary`, also `ring`): the only chromatic brand accent.
  Use it for indicator bars, underlines, the caret, and the focus outline.
  `primary-text` is the lighter blue for text: links and the active tab.
  `primary-wash` is the faint fill behind a selected item. Never use blue as a
  large fill.
- **The site's accent never colors the dashboard.** The site canvas (Write and
  the Split preview) replaces `primary` with the docs site's own accent, so the
  page shows its published colors. Editor chrome inside the canvas (the caret,
  the outline of a selected block, the drop cursor) uses `dashboard-primary`:
  the same blue, under a name the site theme does not set. The canvas also
  keeps the dashboard `ring`.
- **Status colours:** `success` (green) = live / published / operational;
  `warning` (amber) = pending/attention; `destructive` (red) = errors/danger.
- **Sidebar palette:** the sidebar sits one step off the canvas (`sidebar` 0.05)
  with its own `sidebar-foreground` (0.7), `sidebar-accent` hover (0.14), and
  `sidebar-border`. An active nav item has a `secondary` grey fill and
  `foreground` text, with no blue and no left border. Nav rows are 40px tall
  and 4px apart, with soft corners, 14.5px medium text and 18px icons. Their
  hover fill changes in 100ms. The project name above the rows reads as a
  title at rest. On hover it gets the same fill and an up-down arrow, and a
  click opens the project list.
- **Agent activity:** the Agent button sits before the Write and Split switch and
  uses the `Sparkles` icon. Its dot is green and pulses for an active agent,
  `warning` for one that waits for a person, and `muted-foreground` for an idle
  agent. The panel docks at the right of
  the editor, 400px wide, and covers the editor below 820px.
  While the panel is open, a block that an agent changed has a `success` tint and a small mono label with
  the age of the change, such as "JUST NOW". An edit that a person opens from the
  activity list has a stronger tint, and the editor scrolls to it.
- **Scrollbars:** use `scrollbar-subtle` on dark scroll surfaces. Its transparent
  track and square 6px thumb use `scrollbar-thumb`, then lift to
  `scrollbar-thumb-hover` on hover.
- **Always consume colour through semantic Tailwind tokens** (`bg-card`,
  `text-muted-foreground`, `border-border`, `bg-primary`, `bg-sidebar`). Never
  hardcode hex/oklch or use palette utilities like `bg-blue-500` in components.

## Typography

A deliberate **mono + sans split** (the e2b feel):

- **JetBrains Mono** (`font-mono`) — structure and identity: page titles
  (UPPERCASE), section / table / stat / nav-group labels, badges, the terminal
  status bar, code. Dashboard section titles are uppercase, bold, foreground
  text, and large enough to notice (`0.875rem`). Smaller structural labels
  such as table headers and sidebar group labels stay muted and tightly tracked.
- **Inter** (`font-sans`) — everything readable: body copy, descriptions, form
  fields, and **all button labels (sentence case)**. The dashboard shell sets
  `font-sans` at its root; explicit `font-mono` is applied only to the structural
  pieces above.
- **Sora** — not used by the v11 marketing site, which loads Geist and Geist Mono
  in the `_marketing` route head.

Hierarchy is carried by **weight, case, colour, and tracking**, not by many
sizes. Most UI text is `0.875rem`; dashboard section titles should be noticeable
but not hero-sized. Section descriptions/subheaders use sans body text in
`muted-foreground` so they read as secondary to the title. Numbers (stats) are
the rare large element (`stat-value`, mono, `1.875rem`).

## Layout & Spacing

Spacing follows Tailwind's 4px unit. The dashboard is a fixed three-zone shell.

- **Sidebar** — 326px by default, `sidebar` background, hairline right border,
  full window height. A person can drag the right edge to resize it from 240px
  to 480px. A drag near the window edge closes it, and a drag from the window
  edge opens it again. A double click resets the default. The width is saved
  per browser (`lib/dashboard/sidebar-width.ts`). Fixed header: logo, project switcher (colored
  monogram, name, repository), collapse button, "Go to" box. Body: three views
  that slide horizontally in the order Project → Content → Site settings
  (340ms, `cubic-bezier(0.22,0.8,0.2,1)`, with a fade). Only the two views in a
  transition animate. Hidden views are inert. Footer: "Site settings" button,
  then the user row.
- **Top bar** — 52px, bottom border. Sidebar toggle, breadcrumb (current item
  in strong text; parent items hide below 1280px), an optional status such as
  the editor's save state, then actions and a "more" menu.
- **Content column** — **always centred and constrained**: `PageBody` wraps page
  content in `mx-auto max-w-3xl`, and pages lead with `PageHeading` (mono label,
  26px title, muted description). Do not render dashboard content flush-left or
  full-bleed.
- **Editor column** — Write mode: 720px column, 56px top padding, "On this
  page" outline (200px, sticky) to the right, hidden under 1240px and in focus
  mode. Split mode: the MDX source on the left, the rendered preview in a
  browser frame on the right.
- **Status bar** — at the bottom of the main area, from the sidebar edge to
  the right edge, `status-bar-height` (2rem), on `sidebar`: `>_ email:path` on the left, the branch and green
  `● ALL SYSTEMS OPERATIONAL` on the right.
- **Menus and popovers** — `surface-menu`: `popover` fill (#141416),
  `menu-border` (#2e2e33), and the one soft shadow in the system. Highlights use
  `overlay`. Portal content sets `font-sans`, because it renders outside the
  dashboard root.
- **Mobile (under 820px)** — the sidebar becomes a drawer, mode labels become
  icons, the outline and block gutter hide, card grids use one column, settings
  rows stack.
- **Auth pages** — centred bordered card on a grid/dot-pattern canvas.

## Elevation & Depth

This is a **flat, border-defined** system — depth comes from hairline borders and
small lightness steps, **not shadows or blur**.

- Hover fills (`surface-hover`, `accent`, `sidebar-accent`) are only for elements
  that do something on click: links, buttons, toggles, and rows that are one
  link or one button. Key/value rows, table rows, list rows with only inner
  links, badges, and cards get no hover state, so they do not look clickable.
- Separate regions with `1px solid var(--border)` (or `--sidebar-border`), never
  drop shadows. Cards/panels use the `surface-card` utility: `card` fill,
  hairline border, and a 1px inset top highlight (`card-highlight`). They are
  not floating elevated surfaces.
- Focus: every interactive element gets the global `:focus-visible` outline
  (1px `ring`, 2px offset). Do not add per-component focus rings. Full-width
  rows inside a clipped container use `focus-visible:-outline-offset-2`.
- Lists are a single bordered container with `border-t` dividers between rows
  (no per-row shadows or gaps).
- The only "overlays" that may use shadow are inherently floating primitives
  (dropdown menu, command dialog, tooltip, sheet) — keep their shadcn defaults.

## Shapes

**Sharp corners everywhere** — `--radius: 0`. The brutalist signature. `rounded`
tokens resolve to `0px` for `sm`/`DEFAULT`/`md`; `lg`/`xl` add a barely-there
1–2px only where a primitive needs it. The single exception is `full` (9999px)
for circular avatars and status dots. Do not introduce `rounded-md`/`rounded-lg`
softening on dashboard surfaces.

## Components

Reuse these before writing new markup. Layout kit lives in
`components/dashboard/dashboard-header.tsx`; primitives in `components/ui/**`.

- **Buttons** (`ui/button.tsx`) — `default` = white (`foreground`) bg / black
  (`background`) text; `outline` = `card` bg + hairline border; `ghost` =
  transparent + muted text. All sentence-case sans, icon-leading, square.
- **DashboardHeader** — the sticky title bar (title + optional tabs + actions).
- **PageBody** — the centred `max-w-3xl` content column. Every page uses it.
- **SectionLabel** — uppercase-mono foreground heading above a block; keep it
  slightly prominent (`text-sm`, bold) so section starts are easy to scan.
- **SectionDescription** — gray sans copy under a section label; keep it less
  prominent than the section title (`text-muted-foreground`, normal weight).
- **FieldList / FieldRow** — a `surface-card` of key/value rows. The label
  column is 200px (mono uppercase `label`), the value sits next to it (14.5px
  sans, or 13.5px mono with `mono` for slugs, repositories, and paths). Rows
  are `divider` separated and have no hover state. On mobile the label stacks
  above the value. The settings/detail pattern.
- **Toolbar** — search input on the left, primary button on the right.
- **EmptyState** — centred bordered card: mono-UPPERCASE title + sans
  description + CTA button. The standard empty/zero state.
- **Tables** — uppercase-mono muted column headers, hairline row borders, a
  centred muted "No … yet" message when empty.
- **Badges** (`ui/badge.tsx`) — mono, uppercase, tracked. `success` = published/
  live; `muted` = neutral/not-generated; `warning`/`destructive` for states.
- **AppSidebar / command-menu (⌘K) / StatusBar / UserMenu** — the fixed shell
  pieces; keep their structure and order.
- **Inputs** (`ui/input.tsx`) — transparent, hairline border, square, `body`
  type. Search inputs lead with a muted `Search` icon.

Add new primitives with the shadcn CLI (radix base, Tailwind v4, `~/` alias).
After adding, re-theme any injected light/neutral tokens to this dark palette and
convert Tailwind-v3 `[--var]` classes to the v4 `(--var)` form.

## Marketing site

- Markup keeps the design's class names (`hero`, `hr`, `band`, `foot`, …), so
  the generated CSS applies. Add a page by adding `styles/marketing/<page>.css`
  scoped to `.pg--<page>`, importing it in `styles/marketing/index.css`, and
  rendering `<MarketingPage page="<page>">`.
- Reuse the shared pieces in `components/marketing/`: `SiteNav`, `SiteFooter`,
  `Hr`, `Ticks`, `Band` (`lib/marketing/bands.ts` seeds), and `Aurora`.
- Keyframes in the marketing CSS start with `mk-`, so they never replace a
  Tailwind animation such as `ping` or `pulse`.
- The default 404 (`components/navigation/not-found-page.tsx`, set as
  `defaultNotFoundComponent` in `router.tsx`) can show outside the marketing
  layout. It draws the same look with the global tokens, not the marketing CSS.
- The right column of the home hero draws two robotic hands that solve a cube
  (`components/marketing/home/hero-solve.tsx`, art in `lib/marketing/solve-art/`). The
  About page section "How we solve docs for the age of AI" uses the same art, and it is
  hidden for now by `SHOW_SOLVE_SECTION` in `about-page.tsx`. It uses
  plain WebGL2 with no library, and its code comes with the page. It plays by
  itself for every visitor, including visitors with reduced motion (a product
  decision), loops, runs only on screen, and has a Pause button. Its colors are the
  theme's (ice, accent, deep, lavender, text), with the Doxa logo on the cube. The motion comes from a speedcuber's solve: both hands grip from the sides,
  wrists rock for R and L, single fingers flick U and D, and one hand opens wide to
  take a new grip when the cube rolls. A solve starts scrambled. When it ends, one
  hand shakes the cube and the cube is scrambled again, with no scramble moves.
  `apps/web/tests/solve-art.test.ts` holds these rules.
- On windows of 1400px or wider, the About hero shows two robotic hands in the empty
  space beside its content (`components/marketing/about/hero-frisbee.tsx`, art in
  `lib/marketing/frisbee-art/`). They throw a disc behind the content, and it adds no
  layout. It plays by itself for every visitor, loops, and has a Pause button. When
  the visitor scrolls past it or leaves the page, a disc in flight first reaches a
  hand, and the art waits until the visitor sees it again. After a press on Pause, it
  stays paused until a press on Play. The disc has the look of the Doxa logo. Some catches become a trick, at random: a finger
  spin, a back roll, a magnetic orbit or the Force, which stops the disc in the
  air with a raised palm (`lib/marketing/frisbee-art/tricks.ts`). A click on a hand
  knocks it (`lib/marketing/frisbee-art/kick.ts`). A hand with the disc drops it on the
  bottom line of the hero. The hand then jabs an angry palm-up "why?!" at the visitor,
  and it picks the disc up again. The canvas takes no pointer events, so the page keeps
  all of its clicks (`lib/marketing/frisbee-art/poke.ts`). The values to play with are in `lib/marketing/frisbee-art/settings.ts`. The hands are the same hands as on the About
  page: `standardFingers` and `drawHand` in `lib/marketing/solve-art/rig.ts`. Use them
  for any other robotic hand on the site.
- Links and placeholder destinations live in `lib/marketing/links.ts`. Copy in
  square brackets (`[RELEASE DATE]`, `[PRICE]`) is a placeholder for a real
  fact; do not replace it with an invented value.

## Do's and Don'ts

**Do**
- Consume colour, type, and spacing through semantic tokens and the components
  above; treat globals.css as the value source of truth.
- Keep page content centred via `PageBody`; lead pages with a mono UPPERCASE
  title and put actions in the content toolbar.
- Use mono+UPPERCASE for structure labels and sentence-case sans for body and
  buttons.
- Define regions with hairline borders and lightness steps; keep corners sharp.
- Reserve blue for focus/identity and green for live/operational state.
- After any class/token change, restart the dev server (Tailwind v4 HMR may not
  regenerate brand-new utilities) and verify the UI is screenshot-identical for
  refactors.

**Don't**
- Don't hardcode hex/oklch or use palette utilities (`bg-blue-500`); no `dark:`
  overrides — the app is single-theme dark.
- Don't use the Tailwind-v3 bracket var form `w-[--sidebar-width]`; it silently
  compiles to nothing under v4. Use `w-(--sidebar-width)`.
- Don't add radii/rounded softening, drop shadows, or blur to dashboard surfaces.
- Don't render dashboard content flush-left or full-bleed.
- Don't make buttons uppercase/mono, and don't scatter blue or green as decoration.
- Don't reinvent layout markup when the kit (DashboardHeader, PageBody,
  SectionLabel, FieldRow, Toolbar, EmptyState) already covers it.
- Don't respect the Reduce Motion setting (`prefers-reduced-motion`,
  `motion-reduce:`, `matchMedia`). Spinners, transitions and art move for every
  visitor (a product decision). A still spinner reads as a stuck page.
