# Site config and artifact schema v2

Status: design approved in conversation, not implemented.
Date: 2026-09-23.
Decision: one `doxa.json` site config per artifact, stored as `settings/site.json`, introduced as artifact schema version 2.

This spec is the first of two. The second spec, "Docs branching", depends on it. This spec does not depend on branching.

Implement without subagents. Follow the project clean-code skill (`i-coderone-clean-code`) and the repository instructions in `AGENTS.md`. Security and clean code are acceptance criteria in this spec, not optional polish.

This handoff describes implementation work. It does not authorize a commit, a deployment, a live migration, or a change to golden files. Get explicit approval for each of these.

## 1. Goal and scope

Give each docs site its own appearance and chrome. A project owner can change:

- the site title and description,
- the theme: a curated preset, token overrides, or an uploaded `theme.json`,
- the logos (light and dark), the favicon, and the Open Graph image,
- the navbar: the call-to-action (CTA) button, extra links, and the GitHub link,
- the footer: link groups and social links,
- the feature flags that exist today.

The owner edits these values in the dashboard, with a form or with a raw JSON editor. Both edit the same object.

All current behavior must continue to work:

- Dynamic Worker rendering and SSR,
- pre-rendered HTML and pre-rendered route data,
- the host cache, the HTML cache, and cache purge on publish,
- every published artifact of schema version 1.

### In scope

- New package `@doxahq/site-config`: schema, defaults, resolver, theme presets, CSS output, legacy upgrade, JSON Schema output.
- Artifact schema version 2 in `@doxahq/docs-engine`, with frozen fixtures.
- Readers: `apps/docs-runtime`, `apps/docs-template`, the content editor service in `apps/api`, and `apps/docs-prerenderer` through the template.
- Writers: `createRuntimeDocsArtifacts`, the starter publication, the draft publication, the generation pipeline, and `apps/agent-container`.
- Site assets: upload, storage, and public delivery.
- Dashboard: a reusable CodeMirror editor, a reusable draft-buffer hook, and a site settings dialog in the content editor, with a form and a raw JSON editor.
- Validation and error reporting in the UI, with one issue model for the client and the API (section 10).
- The entitlement backbone for "Powered by Doxa": only paid plans can remove it (section 6.9).
- A new edit operation `set_site_config` on the existing content mutation channel.

### Explicit exclusions

- NO custom CSS. The schema has no field that accepts raw CSS.
- NO custom scripts, analytics tags, or HTML injection.
- NO uploaded font files. Fonts come from a curated allowlist only.
- NO branching. Settings edits go to the existing draft (`drafts/current`) until the branching spec replaces it.
- NO sync from a `doxa.json` file in the user repository. This comes later, as an import.
- NO per-page overrides of the site config.
- NO Content-Security-Policy rollout on docs hosts. Section 15 lists it as a follow-up. The design keeps a strict policy possible.

## 2. Repository facts

These facts were checked in the code on 2026-09-23. They explain why the current settings cannot support per-site customization.

| Fact | Location |
|---|---|
| The root route reads theme, color, SEO, and site values from build-time modules. One renderer build gives one appearance for all sites. | `apps/docs-template/src/routes/__root.tsx` |
| The navbar reads `Navigations`, `GitHubLink`, and `Settings.features.ai.chat` from static modules. | `apps/docs-template/src/components/navigation/navbar.tsx` |
| The footer reads `Settings.company` and `Settings.features.branding` from a static module. | `apps/docs-template/src/components/navigation/footer.tsx` |
| The logo paths are hardcoded (`/doxa-logo-new-dark.svg`, `/doxa-logo-new-light.svg`). | `apps/docs-template/src/components/navigation/logo.tsx` |
| The theme provider and the theme toggle read `activeTheme` from a static module. | `apps/docs-template/src/providers/index.tsx`, `components/theme-toggle.tsx` |
| `llms.txt`, `llms-full.txt`, the chat API, and the agent system prompt read `Settings.site.name` statically. | `routes/llms[.]txt.ts`, `routes/llms-full[.]txt.ts`, `lib/chat-api.ts`, `lib/agent/system-prompt.ts` |
| Some feature flags come from route data (`docs-page.tsx`). Others come from the static `Settings.features`. A per-site flag can therefore apply on one component and not on another. | `components/docs-page.tsx`, `components/toc/*` |
| `getThemeConfig`, `getCompanyConfig`, and `getSocialConfig` exist on the runtime source, but no renderer code calls them. The runtime returns hardcoded values. | `apps/docs-runtime/src/runtime-source.ts:847-879` |
| The site name is the project slug. | `apps/docs-runtime/src/runtime-source.ts` `getSiteConfig` |
| Per-site features come from `settings/features.json` in the artifact. Only `apiPlayground` is written today. | `packages/docs-engine/src/index.ts` `createRuntimeDocsArtifacts` |
| Theme names are a closed TypeScript union. `tokensToCss` maps 36 tokens by hand. | `apps/docs-template/src/lib/themes.ts` |
| The draft publication copies every base object and stamps the current schema version on the manifest. After a writer flip, a v1 base gets a v2 manifest without v2 files. Section 7.3 corrects this. | `apps/api/src/services/docs-content/artifacts.ts` `applyManifestEdits` |
| The public route-data contract is strict and carries `site` and `features` for each page. | `packages/contracts/src/docs-prerender.ts` `pageDataFields` |
| The artifact identity hashes the artifact prefix. A new version prefix gives a new render ID. | `packages/contracts/src/docs-prerender.ts` `createArtifactIdentity` |
| Docs HTML has no Content-Security-Policy header today. | `apps/docs-dispatcher/src/security-headers.ts` |
| The dashboard source editor is CodeMirror 6, loaded on demand. Autosave logic lives inside `use-project-content.ts`. | `apps/web/src/components/dashboard/content/mdx-code-editor.tsx`, `apps/web/src/lib/dashboard/use-project-content.ts` |
| All packages use Zod 4. `z.toJSONSchema` is available. | `package.json` files |

## 3. Design decisions

1. **One config per artifact.** The resolved config is a file in the immutable artifact prefix. A config change makes a new version, so the version-keyed caches, the purge, the prerender identity, and rollback work with no new mechanism.
2. **Schema version 2.** v2 requires `settings/site.json` and drops `settings/features.json`. A v1 reader cannot render v2 correctly, so the bump is necessary.
3. **Upgrade on read.** Readers convert v1 artifacts with `upgradeV1SiteConfig`. After this step, every consumer sees one shape: `ResolvedSiteConfig`.
4. **Strict on write, lenient on read.** The API rejects any invalid or unknown field. The runtime drops an invalid field, uses its default, and logs a warning. A bad config never takes a live site down.
5. **The config is data, never code.** No field accepts CSS, HTML, script, or a free URL for a resource. All CSS is generated from validated values.
6. **One source of truth for types.** The Zod schema gives the TypeScript types, the JSON Schema for the editor, and the runtime validation.

## 4. The `doxa.json` format

### 4.1 Example

```jsonc
{
  "$schema": "https://doxa.so/schemas/site-config/v1.json",
  "version": 1,
  "name": "Acme Docs",
  "description": "Guides and API reference for Acme.",
  "branding": {
    "logo": { "light": "asset:9f2c…", "dark": "asset:a41b…", "href": "/" },
    "favicon": "asset:77de…",
    "ogImage": "asset:1c0a…",
    "poweredBy": true
  },
  "theme": {
    "preset": "brutalist",
    "defaultMode": "system",
    "primary": "#3b82f6",
    "radius": "0.5rem",
    "fonts": { "body": "Inter", "code": "JetBrains Mono" },
    "tokens": {
      "light": { "background": "oklch(1 0 0)" },
      "dark": { "background": "oklch(0.145 0 0)" }
    }
  },
  "navbar": {
    "cta": { "label": "Get started", "href": "/quickstart", "variant": "primary" },
    "links": [{ "label": "Blog", "href": "https://acme.com/blog" }],
    "github": "https://github.com/acme/app"
  },
  "footer": {
    "groups": [
      { "title": "Product", "links": [{ "label": "Pricing", "href": "https://acme.com/pricing" }] }
    ],
    "socials": { "x": "https://x.com/acme", "github": "https://github.com/acme" }
  },
  "seo": { "keywords": ["acme", "api"], "twitterHandle": "@acme" },
  "features": { "rightSidebar": true, "ai": { "chat": true } }
}
```

Every field is optional. `resolveSiteConfig` fills every missing field with a default.

### 4.2 Two versions, two meanings

- `version` inside `doxa.json` is the **site config format version**. It starts at 1. It changes only when the config format has a breaking change. A reader then migrates the old format on read.
- `schemaVersion` in `manifest.json` is the **artifact schema version**. This spec changes it from 1 to 2.

The two numbers are independent. Do not derive one from the other.

### 4.3 Defaults that depend on the project

`createDefaultSiteConfig({ projectName })` gives the defaults for a new site. The default `name` is the project name, not the slug. This corrects the current slug title.

### 4.4 Uploaded `theme.json`

A `theme.json` file contains only the theme part:

```jsonc
{
  "$schema": "https://doxa.so/schemas/theme/v1.json",
  "name": "Acme",
  "colorMode": "light-dark",
  "radius": "0.5rem",
  "fonts": { "body": "Inter", "code": "JetBrains Mono" },
  "tokens": { "light": { … }, "dark": { … } }
}
```

- The dashboard parses the file with the strict theme schema.
- If the file is valid, the dashboard copies its values into `theme.tokens`, `theme.fonts`, and `theme.radius`. The preset stays as the base for missing tokens.
- The dashboard can also export the resolved theme as `theme.json`. A user can then start from a preset and edit it.

## 5. Package `@doxahq/site-config`

### 5.1 Layout

```text
packages/site-config/
  src/
    primitives/            safe value schemas, one file each
      css-color.ts
      css-length.ts
      font-family.ts
      href.ts
      asset-ref.ts
      plain-text.ts
    schema/                one file for each config area
      theme.ts
      branding.ts
      navbar.ts
      footer.ts
      seo.ts
      features.ts
      site-config.ts       composes the areas and exports the root schema
    presets/
      default.ts
      brutalist.ts
      index.ts             preset registry
    tokens.ts              token keys and their CSS variable names
    resolve.ts             resolveSiteConfig, createDefaultSiteConfig
    parse.ts               parseSiteConfigStrict, parseSiteConfigLenient
    css.ts                 themeToCss
    fonts.ts               font allowlist and stylesheet URL builder
    legacy.ts              upgradeV1SiteConfig
    json-schema.ts         JSON Schema output
    index.ts               public API
  scripts/emit-json-schema.ts
  tests/
```

Each file has one responsibility. The `schema/` files import only from `primitives/`. `resolve.ts` and `css.ts` import only from `schema/`, `presets/`, and `tokens.ts`. The package has no runtime dependency on React, Workers, or any app.

### 5.2 Public API

```ts
export type SiteConfigInput = z.input<typeof siteConfigSchema>;
export type ResolvedSiteConfig = z.output<typeof siteConfigSchema>;
export type ResolvedTheme = ResolvedSiteConfig["theme"];

export function parseSiteConfigStrict(input: unknown): StrictParseResult;
export function parseSiteConfigLenient(input: unknown): LenientParseResult;
export function resolveSiteConfig(input: SiteConfigInput): ResolvedSiteConfig;
export function createDefaultSiteConfig(project: { projectName: string }): SiteConfigInput;
export function upgradeV1SiteConfig(input: LegacyV1Settings): SiteConfigInput;
export function themeToCss(theme: ResolvedTheme): string;
export function fontStylesheetHref(theme: ResolvedTheme): string | null;
export function hashSiteConfig(config: ResolvedSiteConfig): Promise<string>;

export function enforceEntitlements(
  config: SiteConfigInput,
  entitlements: ProjectEntitlements,
): SiteConfigInput;

type StrictParseResult =
  | { ok: true; config: SiteConfigInput }
  | { ok: false; issues: ValidationIssue[] };

type LenientParseResult = {
  config: ResolvedSiteConfig;
  droppedPaths: string[];
};
```

`ValidationIssue` is the one issue model for the package, the API, and the dashboard. Section 10.2 defines it.

Rules for the types:

- Derive every type from the Zod schemas. Do not write a parallel interface.
- Do not use `any`. Do not use `as` to silence the compiler.
- Use discriminated unions for results, as shown above.
- Use `satisfies` for the preset registry and the token map, so that a missing key fails at compile time.

### 5.3 Strict and lenient parse

- `parseSiteConfigStrict` uses `.strict()` objects. Unknown keys are errors, so a typo fails when the user saves. It converts every Zod issue into a `ValidationIssue` with a JSON pointer and a stable code (section 10.2). The dashboard shows each issue on the related field and in the raw editor.
- `parseSiteConfigLenient` starts with the strict parse. For each issue, it removes the smallest invalid node from a copy of the input. For an invalid array item, it removes only that item. Then it parses again. It stops after 32 passes or when the parse succeeds. Unknown keys are stripped. The result always resolves, because every field has a default.

This keeps one schema for both modes. Do not write a second, lenient copy of the schema.

### 5.4 Theme tokens

`tokens.ts` holds one map from token key to CSS variable name:

```ts
export const THEME_TOKEN_CSS_VARIABLES = {
  background: "--background",
  foreground: "--foreground",
  // … every token that exists in ThemeTokens today
  codeBorder: "--code-border",
} as const satisfies Record<string, `--${string}`>;

export type ThemeTokenKey = keyof typeof THEME_TOKEN_CSS_VARIABLES;
```

- The token schema is built from this map, with a fixed key set. It is not `z.record`. An unknown token key is an error in strict mode.
- `themeToCss` loops over this map. It never uses a key from the input as a CSS name.
- To add a token, add one line to the map and one value to each preset. The compiler reports every missing value.

### 5.5 Presets

- Presets move from `apps/docs-template/src/lib/themes.ts` into `presets/`. They become data with the `ThemePreset` type.
- The registry is `as const satisfies Record<string, ThemePreset>`. `ThemePresetName` is `keyof typeof THEME_PRESETS`.
- Preset `extraCss` stays possible for Doxa-authored presets only. It is a constant in the source, never input. The config schema has no `extraCss` field.
- The launch list is `default` and `brutalist`. More presets come after the first implementation. A new preset is one new file in `presets/` and one registry entry.

### 5.6 Fonts

- `fonts.ts` holds an allowlist of font families with their Google Fonts family names and weights.
- The config accepts only a family name from this allowlist.
- `fontStylesheetHref` builds the Google Fonts URL on the server from the allowlist values. No part of the URL comes from input.
- The renderer adds `preconnect` links only if the resolved theme uses a Google font.

## 6. Security requirements

Each item is a requirement. Each item has tests in section 13.

### 6.1 CSS injection

A theme value goes into a `<style>` element. An unsafe value can close the rule, add new rules, load a remote resource, or close the `<style>` element.

- `css-color.ts` accepts only these grammars, with bounded numbers:
  - `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`,
  - `rgb()`, `rgba()`, `hsl()`, `hsla()`, `oklch()`, `oklab()` with numeric arguments, optional `%`, optional `deg`, and an optional `/ alpha`.
- `css-length.ts` accepts `0`, or a number from 0 to 4 with the unit `rem`, or a number from 0 to 64 with the unit `px`.
- Both primitives are allowlist regular expressions with anchors (`^…$`). They also reject any value longer than 64 characters.
- There is no denylist. The tests must still prove that the primitives reject `;`, `{`, `}`, `<`, `>`, `\`, `/*`, `url(`, `image-set(`, `expression(`, `@import`, `var(`, CSS escapes (`\75rl(`), and non-ASCII look-alike characters.
- `themeToCss` asserts that its output contains no `<`. This is a second barrier in case a primitive has a bug. If the assertion fails, `themeToCss` returns the CSS of the default preset and logs `site_config_css_rejected`.

### 6.2 Links

Navbar, CTA, footer, social, and GitHub links are rendered as `<a href>`.

- `href.ts` accepts exactly two forms:
  - **Internal:** starts with one `/`, is not `//`, has no `\`, no control characters, and no whitespace. It is normalized with `normalizeRuntimeHref` rules.
  - **External:** parses with `new URL()`, and the protocol is `https:`, `http:`, or `mailto:`.
- Any other form is an error: `javascript:`, `data:`, `vbscript:`, `file:`, protocol-relative URLs, and relative paths without `/`.
- The length limit is 2048 characters.
- The renderer sets `rel="noopener noreferrer"` on each external link. An external link opens in the same tab unless `newTab: true` is set.
- The social link schema accepts only `https:` URLs.

### 6.3 Text

- `plain-text.ts` trims the value, rejects control characters, and applies a length limit for each field: `name` 80, `description` 300, link `label` 40, CTA `label` 30, footer group `title` 40, a keyword 40.
- React escapes all text on output. No text field goes into `dangerouslySetInnerHTML`.
- The `<title>` and `<meta>` values go through TanStack `head()`, which escapes them.

### 6.4 Sizes and counts

| Limit | Value |
|---|---|
| Serialized `doxa.json` | 64 KiB |
| Uploaded `theme.json` | 32 KiB |
| Navbar links | 8 |
| Footer groups | 6 |
| Links in one footer group | 12 |
| Keywords | 20 |
| JSON nesting depth | 8 |

The API checks the byte size before it parses the JSON.

### 6.5 Assets

Assets are logos, the favicon, and the Open Graph image.

**Upload**
- Route: `POST /projects/:projectId/assets`. The session user must own the project. The service resolves the site from the database, never from the request body.
- The request carries one file. Size limits: logo 512 KiB, favicon 128 KiB, Open Graph image 2 MiB.
- The service detects the type from the magic bytes. It ignores the file name and the client content type. It accepts PNG, JPEG, WebP, ICO, and SVG.
- An SVG goes through an allowlist sanitizer. The sanitizer keeps only known shape, gradient, and style elements and attributes. It removes `<script>`, `<foreignObject>`, every `on*` attribute, and every `href` or `xlink:href` that is not a local fragment (`#id`). It also removes `<style>` content with `@import` or `url(`. If the sanitized SVG is different from the input, the service stores the sanitized version.
- The service computes SHA-256 of the stored bytes and writes `sites/<siteId>/assets/<sha256>` with the detected content type in the R2 HTTP metadata. If the object exists, the write is skipped.
- The response is `{ ref: "asset:<sha256>", contentType, size }`.

**Reference**
- `asset-ref.ts` accepts only `asset:` followed by 64 lowercase hex characters.
- A config cannot contain an asset URL. It contains only an asset reference.

**Delivery**
- Public path: `/_doxa/assets/<sha256>`. The dispatcher routes this path to the docs runtime.
- The runtime resolves the site from the trusted host mapping. It serves an asset only if the resolved version's `site.json` references this hash. An upload that was never published is not public.
- Response headers:
  - `Content-Type` from the stored metadata,
  - `Cache-Control: public, max-age=31536000, immutable`,
  - `X-Content-Type-Options: nosniff`,
  - for SVG, also `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`.
- The dashboard shows unpublished assets through an authenticated API route: `GET /projects/:projectId/assets/:sha256`.

**Storage GC**
- Assets are outside the version prefix. The storage GC must treat an asset as live if any retained version's `site.json`, or the current draft, references it. Add this rule to `docs/current/storage-garbage-collection.md`.

### 6.6 Object keys

- Zod 4 object parsing copies only known keys, so `__proto__` and `constructor` in the input have no effect on the output.
- The token schema uses fixed keys, not records.
- The runtime runs `assertSafeObjectKeys` on the raw JSON before the lenient parse. This function is private in `packages/contracts/src/docs-prerender.ts:924` today. Export it from `@doxahq/contracts/docs-prerender`, or move it to a shared module in `@doxahq/contracts`, and reuse it. Do not write a second copy.

### 6.7 Integrity of the stored config

- The v2 manifest stores the SHA-256 of `settings/site.json`.
- The runtime computes the hash of the bytes that it reads. If the hashes are different, the runtime uses the default config for the site and logs `site_config_integrity_mismatch`.
- The runtime never trusts stored data because Doxa wrote it. It always runs the lenient parse.

### 6.8 Authorization of edits

- Settings edits use the existing content service. Authorization resolves through `DocsContentActor.userId`, as today.
- `set_site_config` is available to the `editor`, `agent`, and `mcp` origins. The agent and MCP origins can reference existing assets. They cannot upload assets.

### 6.9 Entitlements: "Powered by Doxa"

Decision: only paid plans can remove the "Powered by Doxa" mark. The visual design of the mark is out of scope. This spec builds only the enforcement backbone.

No billing or plan model exists in the code today. The backbone is therefore an interface that the billing work implements later.

**Contract** (`packages/contracts/src/entitlements.ts`)

```ts
export const projectEntitlementsSchema = z.object({
  removePoweredBy: z.boolean(),
}).strict();

export type ProjectEntitlements = z.infer<typeof projectEntitlementsSchema>;

export const FREE_PLAN_ENTITLEMENTS = {
  removePoweredBy: false,
} as const satisfies ProjectEntitlements;
```

A later entitlement is one new boolean or limit in this schema.

**Service** (`apps/api/src/services/entitlements.ts`)

```ts
export interface EntitlementsService {
  getProjectEntitlements(projectId: string): Promise<ProjectEntitlements>;
}
```

- The first implementation returns `FREE_PLAN_ENTITLEMENTS` for every project. The billing work replaces it and changes no caller.
- The content service receives the `EntitlementsService` through its constructor. It does not import an implementation.

**Rules**

| Writer | Rule |
|---|---|
| Editor, agent, or MCP save (`set_site_config`) | If `branding.poweredBy` is `false` and `removePoweredBy` is `false`, reject the edit with the issue code `entitlement_required` at `/branding/poweredBy`. |
| Draft publish | Check the rule again. If it fails, reject the publish with the same issue. This covers a plan that ended after the save. |
| Generation and starter writers | These writers cannot ask the user. They apply `enforceEntitlements(config, entitlements)`, which sets `poweredBy` to `true`, and they log `site_config_entitlement_applied`. |
| Readers | No check. The renderer shows what the published artifact contains. The billing spec defines what happens to published sites after a downgrade. |

- `enforceEntitlements` is a pure function in `@doxahq/site-config`. It returns a new object and does not change its input.
- The dashboard gets the entitlements in the content overview (section 9.4). The UI rules are in section 10.6.

### 6.10 Cache safety

- The config comes only from the artifact of the resolved version. No request header, query parameter, or cookie can change it.
- The HTML cache key does not change. A config change is a new version, so it is a new key.

## 7. Artifact schema version 2

### 7.1 Manifest

`packages/docs-engine/src/manifest.ts` defines one schema for each version:

```ts
const docsManifestV1Schema = z.object({
  schemaVersion: z.literal(1),
  siteId: z.string(),
  versionId: z.string(),
  projectSlug: z.string(),
  generatedAt: z.string(),
  pages: z.array(docsManifestPageSchema),
});

const docsManifestV2Schema = docsManifestV1Schema.extend({
  schemaVersion: z.literal(2),
  siteConfig: z.object({
    path: z.literal("settings/site.json"),
    sha256: sha256HexSchema,
  }),
});

export type DocsManifestV1 = z.infer<typeof docsManifestV1Schema>;
export type DocsManifestV2 = z.infer<typeof docsManifestV2Schema>;
export type DocsManifest = DocsManifestV1 | DocsManifestV2;
```

- `parseDocsManifest` reads `schemaVersion` first, as today, and then selects the schema for that version.
- A manifest without `schemaVersion` is still version 1.
- `SUPPORTED_DOCS_ARTIFACT_SCHEMA_VERSIONS` becomes `[1, 2]`.
- `DOCS_ARTIFACT_SCHEMA_VERSION` stays `1` until phase 4 (section 12). Phase 4 changes it after phases 2 and 3 are merged.
- Unknown manifest keys are still stripped.

### 7.2 Artifact layout

| File | v1 | v2 |
|---|---|---|
| `manifest.json` | Required | Required, with `siteConfig` |
| `settings/features.json` | Optional | Not written. A v2 reader ignores it. |
| `settings/site.json` | Not present | Required. The resolved config, canonical JSON. |
| Every other file | No change | No change |

The writer stores the **resolved** config, not the input. The artifact then does not depend on the defaults of a later release.

### 7.3 Writers

**`createRuntimeDocsArtifacts`**
- New input: `siteConfig?: SiteConfigInput`. If it is missing, the writer uses `createDefaultSiteConfig({ projectName })`.
- The existing `features.apiPlayground` input maps into `siteConfig.features.apiPlayground`.
- The writer writes `settings/site.json`, computes its hash, and adds `siteConfig` to the manifest.
- In v2 mode, the writer does not write `settings/features.json`.

**Starter publication** (`apps/api/src/services/starter-docs.ts`)
- The starter publication uses the same writer path and the default config.

**Generation** (`apps/agent-worker`, `apps/agent-container`)
- A generation run keeps the site config of the version that is published at the time. A generation must not reset the user's settings.
- The job reads the config of the base version through the runtime reader, not through its own parser. The job passes the config to the writer.

**Draft publication** (`apps/api/src/services/docs-content/artifacts.ts`)
- Add one step: `upgradeArtifactToCurrentSchema(baseManifest, baseFiles)`. This step runs before `applyManifestEdits`.
- If the base is v1, the step reads `settings/features.json`, builds the config with `upgradeV1SiteConfig`, and adds the project name. It then writes `settings/site.json` and does not copy `settings/features.json`.
- If the draft has a `set_site_config` overlay, the overlay replaces the config.
- `applyManifestEdits` then sets `siteConfig.sha256` from the final `site.json` bytes.
- This step closes the gap that section 2 describes. A test must prove that a v1 base publishes as a complete v2 artifact.

### 7.4 Fixtures

Follow `packages/docs-artifact-fixtures/README.md`:

- Add recipes `starter`, `component-showcase`, and `customized`. `customized` uses the `brutalist` preset, token overrides, a navbar CTA, navbar links, footer groups, and logo references.
- Freeze them with `create-set` into `sets/schema-v2/`. Do this only after phase 4 flips the writer constant.
- Add the golden file `expected/site-config.json` for each v2 set.
- The existing v1 files stay unchanged. Phase 2 adds one new golden file, `expected/site-config.json`, to each `sets/schema-v1/*` folder. The golden file holds the output of `upgradeV1SiteConfig` for that set. The user approved this addition on 2026-09-23. The reviewed diff must show only new files, with no change to an existing file.
- The frozen sets cannot contain invalid data, because a strict writer produced them. The lenient-parse cases live in `packages/site-config/tests/` as test data.

## 8. Readers

### 8.1 Docs runtime

New module: `apps/docs-runtime/src/site-config.ts`.

```ts
export async function readSiteConfig(
  env: RuntimeSourceEnv,
  context: ProjectRuntimeContext,
  runtimeContext: RuntimeRequestContext,
): Promise<ResolvedSiteConfig>;
```

- **v1:** read `settings/features.json` if it exists. Then return `resolveSiteConfig(upgradeV1SiteConfig(...))` with the project name.
- **v2:** read `settings/site.json`, check the hash (section 6.7), run `assertSafeObjectKeys`, and run `parseSiteConfigLenient`. If `droppedPaths` is not empty, log `site_config_fields_dropped` with the paths, but not the values.
- Memoize the result in an isolate-level LRU with 256 entries, keyed by the artifact prefix. The prefix is immutable, so the entry never becomes stale.

Changes to the runtime operations:

- New operation: `getResolvedSiteConfig`.
- `getRouteData` returns an optional `siteConfig` field in its internal RPC response. This saves a second round trip. The public route-data contract (`PublicDocsRouteDataV1`) does not change.
- `getSiteConfig` and `getFeatureConfig` read from the resolved config. `site.name` becomes the configured name.
- `getThemeConfig`, `getCompanyConfig`, and `getSocialConfig` stay, because the contract adds and never removes. They read from the resolved config. Mark them `@deprecated`.
- New asset delivery path: section 6.5.

### 8.2 Renderer (`apps/docs-template`)

New folder: `src/site-config/`.

```text
src/site-config/
  site-config-context.tsx   SiteConfigProvider, useSiteConfig()
  theme-style.tsx           <ThemeStyle>: <style> for the theme CSS, <link> for fonts
  asset-url.ts              assetUrl(ref) → "/_doxa/assets/<sha256>"
  load-site-config.ts       server-side loader with fallbacks
```

**Load path**
1. `server.ts` gets the config with the route data. The internal `getRouteData` response carries it (section 8.1). The config goes into `DocsRequestContext.siteConfig`.
2. If the runtime is older and sends no `siteConfig`, the renderer calls `getResolvedSiteConfig`. If this operation is unknown, the renderer builds the config from `getFeatureConfig` and `getSiteConfig`. This keeps a mixed-release rollout safe in both deploy orders.
3. The root loader returns the config from the request context, with `staleTime: Infinity`. Client navigation does not load it again. A new version already causes `version_mismatch` and a full reload.
4. The prerender path uses the same `server.ts` path, so pre-rendered HTML contains the same config.

**Consumers.** Replace every static import listed in section 2 with `useSiteConfig()`, or with the request context on server-only routes:
- the `head()` values in the root route: title, description, keywords, Open Graph, Twitter, and favicon,
- `ThemeStyle`, `Providers`, and `ThemeToggle`,
- `Navbar`, `Footer`, and `Logo`,
- the `toc` components that read `Settings.features`,
- `llms.txt`, `llms-full.txt`, `chat-api.ts`, and `system-prompt.ts`.

After this change, no component may read `Settings.features`. Every feature flag comes from the resolved config. This also corrects the mixed flag sources that section 2 describes.

**Local development.** The Vite runtime source reads `src/contents/doxa.json`. This file replaces `src/contents/settings/theme.json` and the site values in `src/settings/main.ts`. The file uses the same lenient parse. Local development and production then share one code path.

**Performance**
- `themeToCss` output is memoized by config hash, inside the isolate.
- The theme CSS is inline in `<head>`, so there is no flash of unstyled content and no client JS for the theme.
- The client receives `toClientSiteConfig(config)`, which omits the SEO values. The dehydrated payload must stay under 8 KiB for the `customized` fixture. A test checks this limit.
- An HTML cache hit has no new cost. An HTML cache miss has one small R2 read, and the LRU removes even this read on a warm isolate.

### 8.3 Content editor service (`apps/api`)

- `getOverview` returns `siteConfig: { published: ResolvedSiteConfig; draft: SiteConfigInput | null }`.
- The service reads the published config through the same reader logic as the runtime. Move `readSiteConfig` to `@doxahq/docs-engine` if both apps need it, so that it has one implementation.

## 9. Dashboard (`apps/web`)

### 9.1 Reusable code editor

Extract the CodeMirror setup from `mdx-code-editor.tsx`:

```text
apps/web/src/components/code-editor/
  code-editor.tsx          generic React wrapper
  editor-theme.ts          editorTheme + highlightStyle, unchanged values
  base-extensions.ts       createBaseExtensions({ onSave, onChange, readOnly })
  languages/mdx.ts         markdown({ base: markdownLanguage })
  languages/json.ts        JSON language, JSON Schema lint, completion, hover
```

```ts
interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  readOnly?: boolean;
  language: CodeEditorLanguage;
}

type CodeEditorLanguage =
  | { kind: "mdx" }
  | { kind: "json"; schema?: JSONSchema7 };
```

- `code-editor.tsx` keeps the current design. It creates the view one time, keeps the callbacks in refs, and applies `value` and `readOnly` changes through effects and compartments.
- The language is a compartment. A language change reconfigures the view and does not rebuild it.
- Each language module loads on demand. The JSON Schema code does not add bytes to the MDX editor.
- JSON support: `@codemirror/lang-json`, `@codemirror/lint`, and `codemirror-json-schema`. Check the bundle size before you add them. Record the size in the pull request.
- `mdx-code-editor.tsx` becomes a thin wrapper with the same default export and props. The content editor must behave and look the same.

### 9.2 Reusable draft buffer

Extract the autosave logic from `use-project-content.ts` into `apps/web/src/lib/dashboard/use-draft-buffer.ts`:

```ts
interface UseDraftBufferOptions<TValue> {
  key: string | null;
  savedValue: TValue | null;
  save: (value: TValue) => Promise<void>;
  isEqual?: (left: TValue, right: TValue) => boolean;
  delayMs?: number;           // default 1200
}

interface DraftBuffer<TValue> {
  value: TValue | null;
  setValue: (value: TValue) => void;
  isDirty: boolean;
  flush: () => Promise<boolean>;
  cancelAutosave: () => void;
}
```

- The hook owns the timer, the save queue, and the flush. The behavior is the same as today: a 1.2-second idle save, a save on `Cmd+S`, a flush before a page switch, and a flush before publish.
- `use-project-content.ts` uses the hook with `TValue = string`. Its behavior must not change.
- The settings editor uses the hook with `TValue = SiteConfigInput`.

### 9.3 Site settings dialog

**Location.** The site settings live inside the content editor. They have no route and no page:

- The content editor toolbar gets an icon button (lucide `Settings2`), with the tooltip "Site settings" and `aria-label="Site settings"`. It sits next to the view-mode buttons in `project-content-page.tsx`.
- The button opens `SiteSettingsDialog`, a large dialog built on the existing `ui/dialog.tsx` and `ui/tabs.tsx`.
- The dialog has one tab for each config area: Branding, Theme, Navbar, Footer, SEO, Features, and JSON.
- A tab label shows a count badge when its area has errors (section 10.5).
- The dialog content is loaded on demand. The JSON tab loads the CodeMirror JSON module only when the user opens it.

Follow the dashboard architecture rules in `AGENTS.md`:

```text
apps/web/src/components/dashboard/content/
  project-content-page.tsx                  adds the settings button only
  site-settings/
    site-settings-button.tsx
    site-settings-dialog.tsx                dialog shell, tabs, summary, footer
    site-settings-form.tsx                  TanStack Form instance and wiring
    site-settings-issue-summary.tsx         issue list with "go to field" links
    tabs/branding-tab.tsx
    tabs/theme-tab.tsx
    tabs/navbar-tab.tsx
    tabs/footer-tab.tsx
    tabs/seo-tab.tsx
    tabs/features-tab.tsx
    tabs/json-tab.tsx                       raw editor on CodeEditor
    fields/validated-field.tsx              label, control, message, a11y wiring
    fields/link-list-field.tsx              reused by navbar and footer
    fields/asset-upload-field.tsx           reused by logo, favicon, OG image
    fields/color-token-field.tsx
    fields/entitlement-gate.tsx             disabled control with a plan badge
apps/web/src/lib/queries/site-settings.ts           query keys and queryOptions
apps/web/src/lib/dashboard/use-site-settings.ts     data hook on use-draft-buffer
apps/web/src/lib/dashboard/validation-issues.ts     issue store and path helpers
apps/web/src/lib/api-errors.ts                      ApiValidationError
```

**Behavior**

- **One state object.** The form and the JSON tab edit one `SiteConfigInput` in `useDraftBuffer`.
- **JSON tab.** The JSON tab keeps its own text. When the text parses and passes `parseSiteConfigStrict`, it updates the shared object. The form text is regenerated with `JSON.stringify(config, null, 2)` and a stable key order.
- **Saving.** A save sends `{ type: "set_site_config", config }` to `POST /projects/:projectId/content/edits`. The dialog and the page editor share one draft and one publish action.
- **Closing.** If the dialog has changes that cannot be saved because of errors, closing it asks for confirmation. The message is: "Some settings have errors and are not saved. Close and lose these changes?"
- **Theme tab.** It has a preset picker, a primary color, a radius, font pickers from the allowlist, token overrides, an "Upload theme.json" control, and an "Export theme.json" control.
- **Preview.** A full-site preview needs the branching spec. For this spec, the theme tab shows a small local preview: a navbar, a card, and a code block, styled with the output of `themeToCss`.

### 9.4 Contracts (`packages/contracts`)

- `docsContentEditSchema` gets two operations: `{ type: "set_site_config", config }` and `{ type: "reset_site_config" }`. `config` uses the strict schema from `@doxahq/site-config`.
- The draft stores the config overlay at `drafts/<draftId>/settings/site.json`. The draft metadata gets `siteConfigChanged: boolean`, with the default `false`, so old draft metadata stays readable.
- The content overview DTO gets `entitlements: ProjectEntitlements` and `siteConfig: { published, draft }`.
- The asset upload response gets a DTO schema.
- `validationIssueSchema` and `validationErrorBodySchema` (section 10.2 and 10.3) live in `packages/contracts/src/validation.ts`.

## 10. Validation and error reporting

Validation is a required part of the user experience. A user must see each problem at the field that causes it, with a message that says what is wrong and how to correct it. This section defines where each rule runs and how each problem reaches the user.

### 10.1 Where each rule runs

A rule runs in one of three places:

- **Shared:** the client runs it for instant feedback, and the API runs it again because the client is not trusted. Both use the same function from `@doxahq/site-config`, so the result is the same.
- **API only:** the rule needs data or trust that the client does not have.
- **Client only:** the rule helps the user but does not protect data. A warning never blocks a save.

| Rule | Where | Severity | Code |
|---|---|---|---|
| Value format: color, length, font, href, asset reference | Shared | Error | `invalid_color`, `invalid_length`, `unknown_font`, `invalid_href`, `unsafe_href_protocol`, `invalid_asset_ref` |
| Text length and control characters | Shared | Error | `too_long`, `invalid_text` |
| Item counts (links, groups, keywords) | Shared | Error | `too_many_items` |
| Unknown key (only possible in the JSON tab) | Shared | Error | `unknown_key` |
| Missing required value, wrong type | Shared | Error | `required`, `invalid_type` |
| Unknown preset | Shared | Error | `unknown_preset` |
| Config size (64 KiB) and nesting depth | Shared (client checks first to avoid a request) | Error | `config_too_large`, `too_deep` |
| Internal link target does not exist | Shared (the client has the page list in the content overview) | Warning | `link_target_not_found` |
| Duplicate link in the same list | Shared | Warning | `duplicate_link` |
| "Powered by Doxa" off without the entitlement | API only (the client also disables the control) | Error | `entitlement_required` |
| Asset exists, belongs to this site, and has the correct kind | API only | Error | `asset_not_found`, `asset_wrong_kind` |
| Upload type from magic bytes, size, SVG sanitizing | API only (the client pre-checks size and extension for speed) | Error | `asset_unsupported_type`, `asset_too_large`, `asset_sanitized` (warning) |
| Draft is stale: a newer version was published | API only | Error | `draft_stale` (HTTP 409) |
| JSON syntax in the JSON tab | Client only | Error | `invalid_json` (with line and column) |
| Low contrast between a token pair (WCAG ratio under 4.5 for text pairs) | Client only | Warning | `low_contrast` |
| `theme.json` upload shape and size | Client only before the apply. The next save runs the shared rules. | Error | `invalid_theme_file` plus the shared codes |

An error blocks the save of the config. A warning never blocks it.

### 10.2 The issue model

One model is used by the package, the API response, and the UI:

```ts
export const validationIssueSchema = z.object({
  path: jsonPointerSchema,               // "/navbar/links/2/href", "" for the root
  code: validationIssueCodeSchema,       // z.enum of the codes in section 10.1
  severity: z.enum(["error", "warning"]),
  message: z.string().max(300),          // English fallback text
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
}).strict();

export type ValidationIssue = z.infer<typeof validationIssueSchema>;
```

- `code` is stable. Tests and UI logic depend on the code, never on the message text.
- `params` holds values for the message, for example `{ max: 40 }` for `too_long`.
- `@doxahq/site-config` owns one message table: `formatIssueMessage(code, params)`. The table uses a `Record<ValidationIssueCode, …>` type, so a new code without a message fails at compile time.
- Messages follow one pattern: what is wrong, then how to correct it. Examples:
  - `invalid_href`: "This link is not valid. Use a link that starts with https://, http://, mailto:, or /."
  - `too_long`: "This text is too long. Use {max} characters or fewer."
  - `entitlement_required`: "Only paid plans can hide 'Powered by Doxa'. Upgrade the plan to hide it."
- `toValidationIssues(zodError)` converts Zod issues. It maps each Zod issue to one code. If a Zod issue has no mapping, the result is `invalid_type` with the Zod message, and a test fails. The function is the only place that knows the Zod issue format.

### 10.3 API error response

- A rejected save or publish returns HTTP 422 with this body. It uses the existing `error()` helper in `apps/api/src/http/response.ts`:

```json
{
  "error": {
    "message": "The site settings have 2 errors.",
    "details": { "code": "validation_failed", "issues": [ … ] }
  }
}
```

- Add `validationError(issues)` next to `error()`. Do not build this body by hand in a route.
- A stale draft returns HTTP 409 with `details.code = "draft_stale"`.
- The API always validates the whole config. It returns every issue in one response, not only the first.
- The API never echoes a rejected value in a message. It echoes only the path and the code. A value can hold unsafe text.

### 10.4 Client error handling

- `apiFetch` in `apps/web/src/lib/platform-api.ts` drops `error.details` today. Change it: if `details` parses with `validationErrorBodySchema`, throw `ApiValidationError`. Otherwise keep the current `Error`.

```ts
export class ApiValidationError extends Error {
  readonly issues: readonly ValidationIssue[];
}
```

- Existing callers keep working, because `ApiValidationError` extends `Error` and keeps the same `message`.
- `validation-issues.ts` holds the issue store for the dialog:
  - issues keyed by JSON pointer,
  - a `source` for each issue: `client` or `server`,
  - `pointerToFieldName("/navbar/links/2/href")` gives `"navbar.links[2].href"` for TanStack Form, and `fieldNameToPointer` does the reverse. Both have unit tests with keys that contain `/` and `~`, using the escape rules of RFC 6901.
  - `issuesForTab(tab)` gives the badge counts.

### 10.5 How the UI shows issues

**Timing**
- A field validates on change, with the shared sub-schema for that field. TanStack Form accepts Zod 4 schemas directly as Standard Schema validators.
- A field shows its error after the first blur, or after the first save attempt. The user does not see an error while typing a value for the first time.
- The whole form validates with `parseSiteConfigStrict` before each autosave.
- The JSON tab lints with a CodeMirror linter, 300 ms after the last key press.

**Placement**
- `validated-field.tsx` shows the message under the control. It sets `aria-invalid="true"` and links the message with `aria-describedby`.
- For an array field such as a link list, the message shows on the item and on the list.
- An issue whose path has no form field shows in the issue summary. For example, `unknown_key` from the JSON tab. The summary has a "Show in JSON" action, which opens the JSON tab and moves the cursor to the key. `languages/json.ts` gives `locateJsonPointer(state, pointer)` for this action. It uses the syntax tree of `@codemirror/lang-json`.
- Each tab label shows a count badge for its errors.
- The issue summary lists every issue. Each item has a link that opens the tab and moves focus to the field. The summary is a polite live region (`role="status"`), so a screen reader announces a change.
- Warnings use the `--warning` token. Errors use the `--destructive` token. Follow `apps/web/DESIGN.md`.

**Autosave with errors**
- If the client finds an error, autosave does not send the config. The dialog footer shows: "Not saved: correct 2 errors to save."
- If the client finds no error, autosave sends the config. If the API returns 422 anyway (an API-only rule, or a client on an older release), the store adds the issues with `source: "server"`. They show in the same places.
- A server issue clears when the user changes the value at its path. The next save runs the API check again.
- A failed request without issues (network error, HTTP 500) shows a toast. The buffer stays dirty, and the next autosave tries again. This is the current content editor behavior.

**Publish**
- The publish button of the content editor is disabled while the config draft has an error. Its tooltip says: "Correct the site settings errors to publish."
- The API validates the config again at publish time. If it rejects the publish with 422, the dashboard opens the dialog on the first issue.

**Asset uploads**
- The client checks the size and the extension before the upload. This gives fast feedback only. The API is the authority.
- The field shows the upload progress, then a thumbnail. An API error shows on the field.
- If the API sanitized an SVG, the field shows the `asset_sanitized` warning: "Doxa removed unsafe parts from this SVG. Check the preview."

**`theme.json` upload**
- The client reads the file only if it is 32 KiB or smaller.
- The client parses it with the strict theme schema. The paths in the issues are relative to the file.
- If the file has errors, a panel lists them, and nothing changes in the form.
- If the file is valid, its values go into the form, and the normal save rules run.

### 10.6 Entitlement-gated controls

- `entitlement-gate.tsx` wraps a control that needs an entitlement. When the entitlement is `false`, the control is disabled, shows a "Paid plans" badge, and has a tooltip with the reason.
- The "Powered by Doxa" switch uses this wrapper with `removePoweredBy`.
- A config from the JSON tab with `poweredBy: false` gets the `entitlement_required` issue from the client too, because the client has the entitlements. The API still checks it.
- The wrapper is generic. A later entitlement reuses it with a new key.

## 11. Module boundaries and clean-code rules

- `@doxahq/site-config` is the only module that knows the config shape. Apps import its types and functions. No app defines a config type or a copy of a schema.
- Keep the files small, with one responsibility. As a guide, a file that goes past 300 lines needs a split, and a function that goes past 40 lines needs a review.
- Keep functions pure where possible. `resolveSiteConfig`, `themeToCss`, `upgradeV1SiteConfig`, and both parse functions have no I/O and no global state.
- Inject I/O. `readSiteConfig` receives the storage reader. It does not create it.
- To add a setting:
  1. Add the field with a default in one `schema/*.ts` file.
  2. Read the field through `useSiteConfig()`.
  3. Add a form control in the matching tab, wrapped in `validated-field.tsx`.
  4. If the field adds a new issue code, add the code to `validationIssueCodeSchema` and its message to the message table. The compiler reports a missing message.
  5. Add a test case.
  No other file changes. This is the extension rule that section 3 describes.
- Do not add a feature flag inside a component with a local default. The default belongs in the schema.
- Do not write a validation rule twice. A shared rule lives in `@doxahq/site-config`. The form, the JSON tab, and the API call the same function. A component never contains its own regular expression or length limit.
- Do not branch UI logic on message text. Use the issue `code`.
- Remove the dead static modules after the migration: `settings/theme.ts`, `contents/settings/theme.json`, `schemas/theme.schema.json`, `lib/colors.ts`, and the site part of `settings/main.ts`. Keep a module only if a test proves that something still needs it.
- Comments explain why, not what. Match the comment style of the surrounding code.

## 12. Implementation order

Doxa has no customers yet, and the platform is in development. Downtime between phases is acceptable. There are no deploy gates between phases, and one deploy at the end is sufficient.

The order below comes from code dependencies. Obey it. Each phase is one reviewable change.

| Phase | Work | Needs |
|---|---|---|
| 1 | `@doxahq/site-config` with tests. JSON Schema output. | Nothing |
| 2 | Readers: manifest v1 and v2 schemas, `SUPPORTED = [1, 2]`, the runtime `readSiteConfig`, the new operation, the asset route, the renderer `src/site-config/`, and the static-import removal. v1 goldens must stay green. | Phase 1 merged |
| 3 | Content service: `set_site_config`, the draft overlay, the v1-to-v2 upgrade step, the asset upload, the `EntitlementsService`, `validationError()`, and the issue contracts. | Phase 2 merged |
| 4 | Writer flip: `DOCS_ARTIFACT_SCHEMA_VERSION = 2` in every writer. Freeze `sets/schema-v2/`. | Phases 2 and 3 merged |
| 5 | Dashboard: `code-editor`, `use-draft-buffer`, `ApiValidationError`, the issue store, the site settings dialog, the JSON tab, and the entitlement gate. | Phase 3 merged |

Sections 9.1 and 9.2 (`code-editor` and `use-draft-buffer`) have no dependency. They can be done at any time, in parallel with the other phases.

**What stays required, although there are no customers:**
- Readers support v1 and v2 side by side. The v1 fixtures and goldens stay green. This proves that the versioning system works, and development sites have v1 artifacts.
- Phase 3 comes before phase 4. Without the upgrade step, a draft publish of a v1 site after the flip gives a v2 manifest without `site.json`.
- In phase 4, add this rule to `docs/current/docs-artifact-compatibility.md`: after the first v2 artifact exists, no reader can be older than the phase 2 release.

**Deploy.** After phase 5, deploy in this order: the docs runtime, then the renderer, the prerenderer, and the dispatcher, then the API, `agent-worker`, and `agent-container`, then the web app. The order keeps readers ahead of writers and needs no extra work.

## 13. Verification

### 13.1 Unit tests (`packages/site-config`)

- Each primitive has a table of valid and invalid values. The invalid tables include every attack string in section 6.
- `themeToCss`:
  - the output for each preset matches a snapshot,
  - a property-style test with random valid tokens proves that the output has no `<`, and that each declaration has the form `--name: value`.
- The strict parse returns the correct JSON pointers for nested errors and for unknown keys.
- The lenient parse:
  - drops only the invalid array item,
  - keeps the valid sibling fields,
  - stops after 32 passes on hostile input,
  - never throws.
- `upgradeV1SiteConfig` has a table: no features file, a partial file, a full file, and an invalid file.
- The JSON Schema output matches a committed snapshot. A change to the schema must update the snapshot in the same pull request.
- Every issue code has a message. Every Zod issue kind that the schema can produce maps to a code, with no fallback to `invalid_type`.
- `enforceEntitlements` sets `poweredBy` to `true` without the entitlement, keeps the value with it, and does not change its input.

### 13.2 Compatibility gate

Run the three suites for every read-side change:

```bash
pnpm --filter @doxahq/docs-artifact-fixtures test
pnpm --filter @doxahq/docs-runtime test
pnpm --filter @doxahq/docs-template test
```

- The v1 sets give the same route data and components as before.
- The v2 sets give the expected `site-config.json`.
- A v2 set with a changed `site.json` byte gives the default config and the `site_config_integrity_mismatch` log.

### 13.3 Runtime and renderer

- SSR of the `customized` set contains the theme CSS in `<head>`, the CTA, the navbar links, the footer groups, and the logo `<img>` with `/_doxa/assets/<sha256>`.
- A mixed-release test proves that a new renderer works with an old runtime, and that an old renderer works with a new runtime.
- The asset route:
  - returns 404 for a hash that the resolved config does not reference,
  - returns 404 for a hash that belongs to another site,
  - sets the headers from section 6.5.
- The client payload for the `customized` set is under 8 KiB.

### 13.4 API

- `set_site_config` rejects each invalid case with HTTP 422, the correct JSON pointer, and the correct code. One response contains every issue.
- The rejected value never appears in the response body.
- `poweredBy: false` without the entitlement gives `entitlement_required` on save and on publish. A generation publish sets it to `true` and logs `site_config_entitlement_applied`.
- A stale draft gives HTTP 409 with `draft_stale`.
- A publish of a v1 base with no config edit gives a complete v2 artifact. The artifact has `site.json`, has no `features.json`, and the manifest hash matches.
- Asset upload:
  - rejects a file with the wrong magic bytes,
  - rejects a file that is too large,
  - sanitizes an SVG with `<script>`, `onload`, `<foreignObject>`, and an external `href`,
  - rejects a request from a user who does not own the project.

### 13.5 Dashboard

- The existing content editor tests pass with no change.
- `use-draft-buffer` tests with fake timers cover the idle save, `Cmd+S`, the flush before a switch, and a failed save.
- Round-trip test: form value, then raw text, then parse, gives the same object.
- `apiFetch` throws `ApiValidationError` for a 422 body with issues, and a plain `Error` for other failures.
- `pointerToFieldName` and `fieldNameToPointer` round-trip, including keys with `/` and `~`.
- Dialog component tests:
  - an invalid href shows the message under the field only after blur, sets `aria-invalid`, and adds a count to the tab badge,
  - a server issue shows on its field and clears when the value changes,
  - autosave does not send a config with a client error, and the footer shows the "Not saved" text,
  - an `unknown_key` from the JSON tab shows in the summary, and "Show in JSON" moves the cursor to the key,
  - the publish button is disabled while an error exists,
  - the "Powered by Doxa" switch is disabled with the "Paid plans" badge on the free plan,
  - an invalid `theme.json` shows its issues and does not change the form.
- A keyboard-only check: the user can reach every field, the summary links, and the dialog buttons with Tab, and the focus moves to the first invalid field after a failed save.
- Run `pnpm --filter @doxahq/web typecheck` and `pnpm --filter @doxahq/web build`.

## 14. Decision record

Decisions from the user on 2026-09-23:

1. **Presets at launch.** `default` and `brutalist` only. More presets come after the first implementation.
2. **"Powered by Doxa".** Only paid plans can remove it. This spec builds the enforcement backbone (section 6.9). The visual design of the mark comes later.
3. **Golden files for v1 sets.** Approved: phase 2 adds `expected/site-config.json` to each `sets/schema-v1/*` folder. No existing file changes.
4. **Dashboard location.** The settings live inside the content editor. A settings icon button opens the site settings dialog (section 9.3).
5. **Validation.** UI validation is a required part of the feature. Section 10 defines it.

No open questions remain for this spec.

## 15. Follow-ups outside this spec

- **Content-Security-Policy for docs hosts.** After this spec, all images are same-origin, and fonts come from a fixed host list. A strict policy is then possible. Write a separate spec for it.
- **Docs branching.** A separate spec. It moves the draft overlay into branch working changes. `settings/site.json` becomes one more file in the tree.
- **Custom CSS.** Planned for later. It needs a separate security review.
- **Repository `doxa.json` import.** Planned for later.
