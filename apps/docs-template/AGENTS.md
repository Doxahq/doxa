# Doxa Docs Template

A public documentation renderer built with TanStack React Router, Tailwind CSS, and MDX. It lives at `apps/docs-template` in the Doxa Platform monorepo.

Do not confuse this app with `apps/docs-runtime`. The template renders the public docs experience. The runtime app privately resolves and serves project-scoped published content to this template.

## Build & Dev

- `pnpm install` — install all workspace dependencies from the monorepo root
- `pnpm dev:docs-template` — start this app from the monorepo root
- `pnpm --filter @doxahq/docs-template build` — production build
- `pnpm --filter @doxahq/docs-template generate:docs` — regenerate `src/contents/settings/documents.ts` from folder structure

## Architecture

- MDX components: `src/components/markdown/` (Card, Note, Step, Mermaid, FileTree)
- UI components: `src/components/ui/` (Tabs, Accordion, Button, etc.)
- Component registry: `src/lib/components.ts` — this is where all MDX-available components are registered
- Documentation content: `src/contents/docs/` — MDX files organized in folders
- Navigation config: `src/contents/settings/documents.ts`
- Site settings: `src/settings/main.ts`
- Content access layer: `src/lib/content/` — unified async API (`contentStore`) with pluggable adapters (vite/github) over the template's own content. The chat assistant and its agent tools use it instead of touching `fs` or `child_process`. Edge-safe. Page routes, `.md` routes and the llms routes read the runtime source instead, so a published site only serves its own content. The platform renderer build (`DOXA_RENDERER_BUILD=platform`) has no `contentStore` and no chat.
- Content adapter selection: `src/settings/content.ts` — `CONTENT_SOURCE=vite|github` env var picks backend. Add custom adapters here (R2, KV, Supabase, etc.)
- AI-native routes: `/llms.txt` (page index), `/llms-full.txt` (full corpus) — defined in `src/routes/llms[.]txt.ts` and `src/routes/llms-full[.]txt.ts`, built by `src/lib/llms.ts` from the runtime source in navigation order. Consumed by external AI clients per the llms.txt spec.
- Agent tools: `src/lib/agent/tools/` — `grep` and `cat` consume `contentStore`. No filesystem/subprocess deps; works on Cloudflare Workers and Vercel Edge.

## IMPORTANT: Artifact Compatibility Gate

This renderer is evergreen: one deployed build serves every published customer site. Published artifact sets in R2 never change, so every component, prop, and content shape that ever shipped must keep rendering. The full contract is `docs/current/docs-artifact-compatibility.md` at the monorepo root.

- Never remove or rename an MDX component or a component prop. Add a new one and keep the old one working.
- `src/runtime/artifact-schema-compat.test.ts` parses every page of every frozen artifact set from `packages/docs-artifact-fixtures` and renders it with the portable runtime registry. It does not exercise the production components in `src/lib/components.ts`, so check prop and output changes to those components by hand. Run `pnpm --filter @doxahq/docs-template test` before finishing any change under `src/runtime/`, `src/lib/components.ts`, `src/components/markdown/`, or `packages/mdx-runtime`.
- Do not relax that suite, edit the frozen sets, or regenerate the golden files in `expected/components/` to make it pass. A failure means an already-published page no longer parses, validates, or renders, or its set of MDX components changed. Fix the template, or get explicit user approval for the behavior change first.

## IMPORTANT: Keep the Component Playbook in Sync

The file `agent/component-playbook.md` is the authoritative reference that the Doxa CLI agent reads at runtime to understand what MDX components are available, how to use them, and when to apply them for documentation generation.

**YOU MUST update `agent/component-playbook.md` whenever you:**

- Add a new component to `src/components/markdown/` or register one in `src/lib/components.ts`
- Remove or rename an existing component
- Change a component's props, variants, or behavior
- Change a Markdown rendering feature (images, code blocks, math)

**What to update in the playbook:**

1. **Component Catalog section** — add/update the component entry with its name, all props, variants, when to use it, and a usage example
2. **Anti-patterns section** — add any misuse patterns to avoid
3. **Composition Rules section** — document how the component interacts with others

The agent writes docs for every customer project with this file, so keep it about components and rendering only. `packages/agent` bundles a copy of it for the hosted writer: after you edit the playbook, run `node packages/agent/scripts/sync-component-playbook.mjs` (a test in `packages/agent` fails while the copy is stale). Use neutral examples (for example a generic `@acme/widget` package). Do not add this template's own docs structure, settings files, sections, commands, or features, and do not prescribe page types or page structure.

If the playbook falls out of sync, the CLI agent will generate documentation using outdated or missing component knowledge, producing lower quality output.

## Code Style

- TypeScript strict mode
- Tailwind CSS for styling
- Radix UI primitives for accessible UI components
- Lucide icons. Page and card icons are drawn by `DocsIcon` (`src/components/docs-icon.tsx`) from `@doxahq/docs-prose/icons`: the suggested icons are bundled, and any other Lucide icon comes with the route data (`src/runtime/route-icons.ts`). Never import the full set (`@doxahq/docs-prose/icons/lucide`) into client code. UI icons use `react-icons/lu`.
- All MDX pages use YAML frontmatter with unquoted values
