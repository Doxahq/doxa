# Agent Instructions

## Project Context
- Purpose: private Doxa platform monorepo for dashboard, API, docs content runtime, generation workers, shared agent packages, auth, database, and contracts.
- Main entrypoints:
  - `apps/web`: Doxa homepage and dashboard.
  - `apps/api`: Cloudflare Worker API with Better Auth, GitHub integration, projects, jobs, docs domains, and publish endpoints.
  - `apps/docs-runtime`: private docs content/runtime-source Worker. It serves `/runtime-source` for the shared docs renderer. Its legacy HTML preview route answers only when `DOCS_RUNTIME_HTML_PREVIEW=on` (local/debug smoke tests); production answers 404.
  - `apps/mcp` (Worker `doxa-mcp`): the remote MCP server for agents. It imports `apps/api` services through the `@doxahq/api` exports map. See `docs/current/mcp-server.md`.
  - `apps/agent-worker`: queue consumer for generation jobs.
  - `apps/email-worker` (Worker `doxa-email`): queue consumer that renders and sends email. See `docs/current/email.md`.
  - `packages/email`: provider-neutral email layer (transports, react-email templates, catalog). Only `doxa-email` imports `@doxahq/email/mailer`, which loads React.
  - `apps/try-proxy` (Worker `doxa-try-proxy`): sends the API playground's "Try it" requests. It has no public route, secrets or private bindings. See `docs/current/api-playground-proxy.md`. Never make these calls from the API on ECS: its metadata address returns the credentials of the task role.
  - `apps/search-gateway` (Worker `doxa-search-gateway`, host `lexis.doxa.so`): the public entry point of remote docs search. It takes the site only from the resolved `Origin`, never from a parameter, and it chooses the provider. See `docs/current/docs-search.md`.
  - `apps/agent-container`: Cloudflare container wrapper for repo checkout and filesystem-based agent execution.
  - `packages/agent`: shared documentation-generation agent.
  - `packages/db`: Drizzle schema, migrations, and Hyperdrive/pg client.
  - `packages/contracts`: shared API DTOs and Zod schemas.
  - `packages/docs-engine`: docs artifact paths, manifest helpers, and the artifact schema version contract.
  - `packages/docs-artifact-fixtures`: frozen artifact sets and golden outputs for the artifact compatibility gate.
  - API on Node (in production since 2026-10-24): `apps/api/src/runtime/node` (the Node origin), `apps/api-edge` (the thin `doxa-api` Worker), `packages/api-bridge` (their protocol) and `infra/terraform` (ECS Fargate behind a private Cloudflare Tunnel, reached only through the edge's `ORIGIN` Workers VPC binding; never give the origin a public hostname). See `docs/current/api-node-origin.md`. Add every new RPC entrypoint method to `API_ENTRYPOINT_METHODS`. Keep Node-only code under `apps/api/src/runtime/node`, because `doxa-mcp` and `doxa-docs-resolver` build from `apps/api` as Workers. `terraform apply`, `pnpm deploy:api:ecs` and `pnpm secrets:api:ecs` (the origin secrets in SSM) change production: ask first. `pnpm secrets:api:ecs --list` only reads.
  - Production setup lives in the private ops repo `ipenywis/doxa-ops`, not here: Terraform variables and backend, the Cloudflare ID values, the Deploy Production and Deploy API Origin workflows, and the runbook. This repo is planned to go public, so never commit an account-issued ID (KV, Hyperdrive, zone, VPC Service, account) or an AWS account ID. Wrangler configs hold `${CF_*}` placeholders instead (and `${OPS_*}` for operator values such as admin emails) (`scripts/apply-production-ids.mjs`, see `docs/current/self-hosting.md`). A new placeholder needs its value in `doxa-ops/wrangler/production-ids.json` before the next deploy.
- Important boundaries:
  - `apps/docs-runtime` is not the public docs renderer. The user-facing renderer is `apps/docs-template`, usually deployed as `doxa-docs-renderer`.
  - Local generated docs use `<slug>.localhost:3002`. Production generated docs use `<slug>.doxa.page`, routed to the renderer. `preview.doxa.so` was the public hostname of the private content/runtime Worker; production does not use it (the renderer and dispatcher use service bindings), and it is being retired.
  - `docs.doxa.so` is for the official Doxa docs/demo site and should not be repurposed for generated project previews.
  - Generation previews are public while `DOCS_PREVIEW_GATE_ENABLED` is not exactly `true`. To restore private previews, add a signed short-lived token exchange between `doxa.so` and `doxa.page`, use a host-only redemption cookie, enable the gate, and add a preview access card back to the Doxabot page.
  - Runtime content isolation must be enforced by resolving host/project through platform mappings, then reading only the resolved published R2 artifact prefix.
  - This directory is its own Git repo. Run Git commands from `doxa-platform`, not the parent Doxa workspace.

## How To Work Here
- Read existing patterns before changing code.
- Prefer small, reviewable changes that preserve package/app boundaries.
- Define verification before implementation.
- Keep tests deterministic and local by default.
- Report commands run and checks skipped.
- Before debugging docs rendering, inspect the renderer/runtime-source/API/R2 boundary instead of assuming the template should import platform internals.
- For platform docs performance work, preserve the one-shot `getRouteData` path and avoid reintroducing loader waterfalls.

## Docs Renderer Compatibility Contract
Full contract: [`docs/current/docs-artifact-compatibility.md`](docs/current/docs-artifact-compatibility.md). Read it before touching `packages/docs-engine`, `packages/docs-artifact-fixtures`, `apps/docs-runtime`, `apps/docs-template`, `apps/docs-prerenderer`, the docs-content service in `apps/api`, or any artifact writer.
- The renderer is evergreen. A renderer release applies globally. A dispatcher-only rollback does not restore the shared renderer or docs runtime. Follow the coordinated rollback procedure in the compatibility contract and retain support for every published artifact version.
- Breaking changes go to the write side, never the read side. Readers must accept every version in `SUPPORTED_DOCS_ARTIFACT_SCHEMA_VERSIONS`. Writers stamp `DOCS_ARTIFACT_SCHEMA_VERSION`. A manifest without `schemaVersion` is version 1 and must stay readable forever.
- Must:
  - Parse stored manifests only through `parseDocsManifest` or `parseDocsManifestText` from `@doxahq/docs-engine`.
  - Read and write version artifacts only through the version tree reader and writer in `packages/docs-engine/src/version-tree.ts` (or an app wrapper of them). Use logical keys `{artifactPrefix}/{path}`. See [`docs/current/docs-content-storage.md`](docs/current/docs-content-storage.md).
  - Keep every old artifact shape, MDX component, and component prop readable and renderable. Add, never remove or rename.
  - Run the three compatibility suites before finishing any change on the read side: `pnpm --filter @doxahq/docs-artifact-fixtures test`, `pnpm --filter @doxahq/docs-runtime test`, `pnpm --filter @doxahq/docs-template test`.
  - Add a new `sets/schema-v{N}/` frozen set when a new schema version is introduced, and deploy every reader before any writer emits the new version.
- Must not:
  - Edit, delete, or regenerate anything under `packages/docs-artifact-fixtures/sets/` to make a suite pass. A red compatibility suite means the reader regressed; fix the reader.
  - Relax an assertion in a test file whose header says `ARTIFACT COMPATIBILITY GATE`.
  - Remove a version from `SUPPORTED_DOCS_ARTIFACT_SCHEMA_VERSIONS` or `SUPPORTED_VERSION_TREE_FORMAT_VERSIONS`.
  - Build a blob key in feature code, or delete a blob outside the `docs_site_blobs` collector.
  - Store a renderer build ID on a published version or add any per-site renderer pin. Canary rollout is a planned, separate change and needs explicit user approval.
  - Change the golden files without explicit user approval and a reviewed diff.

## Web Dashboard Architecture
- Keep `apps/web/src/components/**` for React components and component-only UI composition. Do not put TanStack query definitions, API cache helpers, domain models, or reusable data hooks in component folders.
- Put reusable TanStack Query keys and `queryOptions` factories under `apps/web/src/lib/queries/**`. Query modules should own query keys, query functions, stale times, and exported result types so future prefetching, invalidation, and `useQuery` calls share one typed source of truth.
- Put reusable dashboard data/state hooks and cache transformation helpers under `apps/web/src/lib/dashboard/**`. Keep these modules small and focused: cache update helpers, dashboard model/formatting helpers, and data hooks should not be mixed into route files.
- Keep route files under `apps/web/src/routes/**` thin. A route module should primarily register `createFileRoute(...)` and point to a page/layout component; avoid spreading page UI, data shaping, filtering, table rows, forms, or mutation logic inline in route files.
- Put dashboard page/layout components under `apps/web/src/components/dashboard/**`, split by responsibility (`*-page.tsx`, layout components, rows, lists, panels, empty states). Prefer clear reusable components over large inline JSX blocks.
- Refactors must preserve existing behavior and visual output unless the user explicitly asks for UX changes. Keep class names, copy, loading/error/empty states, routing, mutations, and cache invalidation behavior stable while improving structure.
- Before finishing dashboard work, run at least `pnpm --filter @doxahq/web typecheck`; run `pnpm --filter @doxahq/web build` when route, query, or bundling boundaries change.

## Web Dashboard Design System (apps/web)
**Canonical design system: [`apps/web/DESIGN.md`](apps/web/DESIGN.md)** (Google DESIGN.md format — YAML design tokens + application guidance). Read it before building or changing any web UI, and keep it in sync with `apps/web/src/styles/globals.css`. The notes below are a quick reference; DESIGN.md is the source of truth for the visual language.

The dashboard is brutalist-dark with an e2b.dev-inspired layout on Doxa's blue brand. Match this visual language for every dashboard screen and new UI feature; do not change the look unless the user explicitly asks for a UX change.

- **Tokens:** design tokens live in `apps/web/src/styles/globals.css` (single source of truth). Use semantic Tailwind tokens only (`bg-background`, `bg-card`, `text-muted-foreground`, `bg-primary`, `border-border`, `bg-sidebar`/`*-sidebar-*`) — never raw colors (`bg-blue-500`, hex). Keep `--radius: 0` (sharp corners). `--primary` (blue) is the accent, used sparingly; `--success` (green) = live/published/operational; `--warning`/`--destructive` = states.
- **Tailwind v4** (no config file; `@theme inline` in globals.css). For CSS variables in class names use the **parentheses** form `w-(--sidebar-width)`, never the v3 bracket form `w-[--sidebar-width]` — brackets silently compile to nothing under v4. After `shadcn add`, re-theme any injected light/neutral tokens to the dark theme and convert any `[--var]` classes to `(--var)`.
- **Typography (e2b mix):** Inter sans (`font-sans`) for body + buttons (sentence-case); JetBrains Mono (`font-mono`) for page titles (uppercase), section/table/stat/nav-group labels, badges, and the terminal status bar. The dashboard shell sets `font-sans` at its root. The marketing pages (`components/marketing/**`) use their own Geist fonts and plain CSS in `apps/web/src/styles/marketing/`; see "Marketing site" in DESIGN.md.

### Shell & layout (keep this structure)
- **Project-first shell** (`dashboard-layout.tsx`): no workspace screen. `/dashboard` lands in the last opened project (`lib/dashboard/last-project.ts`), else the first, else `/dashboard/projects/new`, the onboarding screen (`new-project-page.tsx`: generate from a GitHub repository, starter or empty docs, and the MCP connect card). The shell always shows one project; `ProjectBranchProvider` holds the single branch selection that the sidebar, top bar, status bar and editor share.
- **Sidebar** (`app-sidebar.tsx`, `components/dashboard/shell/*`): fixed header (logo, `ProjectSwitcher` ⌘P, collapse ⌘\\, "Go to" ⌘K) over three sliding views in `SidebarViewStack` — Project → Content → Site settings (`lib/dashboard/shell-context.tsx`). Hidden views are `inert`. The width is 326px by default; the right edge (`shell/sidebar-resize-handle.tsx`) resizes it from 240px to 480px, closes it when dragged near the window edge, and resets on double click. `lib/dashboard/sidebar-width.ts` saves the width per browser and a head script in `routes/__root.tsx` applies it before the first paint. The Content view body comes from the content route through `useSidebarPanel`. Active nav item = `secondary` grey fill + `foreground` text, with no blue and no left border.
- **Top bar** (`shell/top-bar.tsx`, 52px): sidebar toggle, breadcrumb, optional status, actions, and a "more" menu. `DashboardHeader` is a thin wrapper for pages outside a project section. The content editor (`content/editor-top-bar.tsx`) and site settings render their own top bar.
- **Site settings** are pages under `/dashboard/projects/$projectId/site/*` (Appearance, Navigation, Domains, SEO & sharing, Features, Advanced JSON), sharing one `useSiteSettings` state in `site-settings/site-settings-layout.tsx`. Doxabot has its own project page (`/dashboard/projects/$projectId/doxabot`, after Generations in the sidebar): instructions, pull request previews and the generation cache. Its instructions editor is `/doxabot/instructions`.
- **Editors:** Write mode is TipTap (`content/write-editor/*`, bridge in `lib/editor/mdx-document.ts`): untouched blocks save byte for byte, edited blocks use `formatMdx` style, unsupported blocks are locked `mdxBlock`s. The content editor has two modes, Write and Split. CodeMirror stays for all code editing (the Split source pane, block "Edit MDX", JSON). Split shows the MDX source (CodeMirror) on the left and the rendered `MdxPreview` in a browser frame on the right. Write and the Split preview draw the page inside `SiteCanvas` (`content/site-canvas.tsx`, `lib/dashboard/site-canvas.ts`): the branch's working site theme set as inline CSS variables, the published `ARTICLE_PROSE_CLASS`, and a shared Light/Dark mode. Keep editor chrome (menus, toolbars, the page facts strip) outside the canvas, and take page components from `@doxahq/docs-prose` rather than drawing editor-only look-alikes. Component props are defined once in `lib/editor/component-props.ts`; the component bar (`write-editor/component-toolbar.tsx`) and the card settings popover build their forms from it.
- **Centered content:** wrap page content in `PageBody` and lead with `PageHeading` (mono label, 26px title, muted description).
- **Bottom terminal status bar** (`status-bar.tsx`, under the main area, from the sidebar edge to the right edge; the sidebar keeps the full height): `>_ email:path` left, `branch: name` and green `● ALL SYSTEMS OPERATIONAL` right.
- **Auth:** the dashboard layout (`dashboard-layout.tsx`) guards routes — redirect to `/login` when unauthenticated; `VITE_DEV_USER_ID` bypasses in local dev. When the API sets `AUTH_COOKIE_PREFIX`, set `VITE_AUTH_COOKIE_PREFIX` in `apps/web` to the same value: the web server reads only session cookies with that prefix. Auth via Better Auth client (`lib/auth/use-auth-session.ts`).

### Reusable building blocks (reuse; don't re-implement per page)
- **UI kit** in `components/dashboard/dashboard-header.tsx`: `DashboardHeader`, `PageBody`, `PageHeading`, `SectionLabel` (uppercase mono muted), `FieldList` + `FieldRow` (200px label column, value beside it), `Toolbar` (search left + primary button right), `EmptyState` (centered bordered card: mono-uppercase title + sans description + CTA). Reach for these before writing new layout markup.
- **Pages** are `components/dashboard/*-page.tsx` (`project-overview-page`, `project-generations-page`, `project-settings-page`, `projects-page`, `new-project-page`, `settings-page`) plus `dashboard-layout.tsx`; route files only register `createFileRoute(...)` → page component.
- **Buttons** (`ui/button.tsx`): primary = white bg / black text; `outline` = dark + subtle border; `ghost`; all sentence-case sans, icon-left. **Tables** = uppercase-mono muted column headers + thin row borders + centered empty message. **Bordered lists** = `border border-border` container with `border-t` row dividers. **Login/auth** = centered bordered card on grid/dot-pattern background.
- Add new shadcn components with the CLI (radix base, Tailwind v4, `~/` alias) and reuse existing `ui/*` before writing custom markup.

### Verifying dashboard UI
- Always run `pnpm --filter @doxahq/web typecheck`; run `pnpm --filter @doxahq/web build` when route/query/bundling boundaries change (build also prerenders every route, catching render crashes).
- For visual checks when the Chrome MCP extension is unavailable, drive headless system Chrome via Playwright (`channel="chrome"`, headless) against `pnpm dev:web` with `VITE_DEV_USER_ID` set, and compare screenshots. Refactors must be screenshot-identical.
- Tailwind v4 HMR may not regenerate brand-new utility classes on hot reload — restart the dev server (don't just refresh) after class/token changes.

## Common Commands
- Install: `pnpm install`
- Test all: `pnpm test`
- Typecheck all: `pnpm typecheck`
- Build all: `pnpm build`
- API tests: `pnpm --filter @doxahq/api test`
- Docs runtime tests: `pnpm --filter @doxahq/docs-runtime test`
- Docs runtime typecheck: `pnpm --filter @doxahq/docs-runtime typecheck`
- DB generate: `pnpm db:generate`
- DB check: `pnpm db:check`
- Local DB up: `pnpm db:local:up`
- Local DB migrate: `pnpm db:local:migrate`
- Dev web: `pnpm dev:web`
- Dev API: `pnpm dev:api`
- Dev stack with the API as the Node origin behind the thin Worker: `pnpm dev --api-node`
- Dev docs runtime: `pnpm dev:docs`
- Deploy docs runtime: `pnpm deploy:docs-runtime`

## Guardrails
- Always:
  - Check `git status --short` before edits and before finishing.
  - Keep generated docs rendering data project-scoped and versioned by artifact prefix.
  - Add or update deterministic tests for behavior changes in API, runtime, contracts, generation, or docs artifacts.
  - Treat tests marked `PRODUCTION INCIDENT REGRESSION GUARDRAIL` as incident contracts. If one fails, fix the production behavior; never delete it, weaken its assertions, or rewrite its fixtures merely to make the suite green. Changing an incident contract requires explicit user approval and a documented replacement that preserves the original failure coverage.
  - Prefer typed helpers and Zod/Drizzle/schema contracts over ad hoc string handling.
- Ask first:
  - Editing environment files, secrets, Wrangler production config, DNS/custom-hostname behavior, migrations, deploy scripts, or queue/container behavior.
  - Running migrations, deployments, live Cloudflare/R2/GitHub/OpenRouter checks, or anything that can cost money or mutate remote state.
  - Committing changes.
- Never:
  - Treat `apps/docs-runtime` as the long-term public renderer.
  - Use `GENERATION_MODE=starter-dev` for real project generation.
  - Bypass host/project resolution by trusting client payload fields for project id, artifact prefix, or R2 paths.
  - Read or return artifacts outside the resolved project's published prefix.
  - Revert unrelated user changes.

## Approval Boundary
Do not edit files, install packages, run migrations, commit, deploy, delete data,
or perform other mutating work without explicit written approval.

<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->
