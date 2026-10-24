# Site config implementation report

## State

Phases 1, 2, 3, and 4 are complete. Phase 5 is not started. The local writer
constant is now 2. The phase 4 tests, typechecks, and renderer build pass.

No commit, deployment, migration, or remote mutation was performed.
The existing staged spec and the unrelated docs-branching spec were left unchanged.

## Phase 4 approved name handling

The project input schema permits 120-character names (`contracts/src/index.ts`).
The site-config schema permits 80 characters, while its default factory copies
the project name. A valid existing project can therefore fail generation or a
v1-to-v2 upgrade. Project names can also contain control characters that the
site-config text schema rejects. The spec says to stop when code and spec differ.

User-approved decision (2026-09-24): derive a safe default site name by removing
control characters and shortening it to 80 characters. Keep the stored project
name unchanged. Keep user-edited site names subject to strict validation. Use a
shared helper for default creation and legacy upgrades, not duplicate rules.

## Phase 4 verification plan

Criticality: HIGH (published artifact integrity and preservation of settings).
Gate 0 skip is OFF; gate 1 unit, gate 2 integration, gate 4 contract, and gate 6
property-style checks are ON. Gate 3 is OFF because this phase has no UI change.
Gate 5 smoke is ON but deferred because deployment is not authorized.

| Rationale | Type | Size | Framework | Dependencies | Gate |
| --- | --- | --- | --- | --- | --- |
| Name boundaries, strict edit rejection, config bytes and entitlement enforcement | Unit | Small | Vitest | Shared schemas and writer | 1 |
| Published config into generation and starter publication into artifact storage | Integration | Medium | Vitest | Real reader/writer, in-memory R2, repository doubles | 2 |
| Independently deployed readers must accept writer output and preserve all frozen files | Contract | Medium | Vitest | Frozen v1/v2 sets and actual writer | 4 |
| Arbitrary valid project text must derive a valid, idempotent default without mutation | Property-style | Small | Vitest | Deterministic generated strings | 6 |

Rejected: browser/component/E2E tests, because this phase changes no UI.
Deliberately skipped: remote generation and post-deploy smoke tests, because they
require deployment and remote mutations. No new test library is needed.

Test cases to cover:
- Name lengths 79, 80, 81, and 120; controls; Unicode at the truncation boundary;
  unchanged stored input; strict rejection of invalid user-edited names.
- Default and explicit config; nested feature precedence; free/paid entitlement
  enforcement and event; canonical bytes and matching SHA-256; no features.json.
- First generation, v1 upgrade, published v2 settings distinct from the source
  baseline, missing/cross-site manifest failures, and starter publication.
- Actual writer output matches all three frozen v2 sets byte for byte.
- V1 draft publication produces complete v2 output and preserves page content.

Implemented in the shared default factory and legacy upgrade. Strict user edits
still reject long names and controls. Truncation does not split a Unicode code
point. A name with no display text left uses the schema's `Documentation` fallback.
The stored project name is unchanged. The API v1 upgrade uses the same factory.

## Phase 4 completion report

### Requirements

| Spec requirement | Status | Evidence |
| --- | --- | --- |
| Active writer version 2, supported readers still 1 and 2 | Done | `docs-engine/src/artifact-schema.ts`; all compatibility suites |
| Resolved canonical `settings/site.json` with exact SHA-256 | Done | Shared `site-config-writer.ts`, writer and frozen-byte tests |
| Legacy feature input maps into config; no new `features.json` | Done | Writer and container feature tests; explicit config takes precedence |
| Starter uses the shared writer with defaults | Done | `starter-docs.ts`; stored files checked before publication |
| Generation keeps the currently published config | Done | API resolves the published prefix with the shared reader; both workflow paths and the inline container receive the snapshot |
| Free-plan generation enforcement and event | Done | Shared writer free/paid and input-immutability tests |
| V1 draft publication produces complete v2 artifacts | Done | Real content service tests with active writer, no mocked version constant |
| V2 frozen sets: starter, component-showcase, customized | Done | Prepared in phase 2 with approval; actual phase 4 writer matches all bytes |
| Preserve existing v1 artifacts and outputs | Done | Runtime and renderer suites; no tracked frozen-file changes |
| Document the minimum-reader rollback requirement | Done | `docs/current/docs-artifact-compatibility.md` |
| Approved safe default names | Done | 79/80/81/120 boundaries, controls, Unicode, generated-input invariants, API upgrade |

### Phase 4 files, grouped by package

- **site-config:** `src/primitives/plain-text.ts`, new `src/primitives/site-name.ts`,
  `src/schema/site-config.ts`, `src/resolve.ts`, `src/legacy.ts`, new
  `tests/default-name.test.ts`.
- **contracts:** `src/index.ts` adds optional config and entitlement fields to
  generation context and container request schemas. Older contexts remain valid.
- **docs-engine:** `src/artifact-schema.ts`, `src/index.ts`, new
  `src/site-config-writer.ts`; `tests/index.test.ts`, `tests/manifest.test.ts`,
  new `tests/site-config-writer.test.ts`.
- **API:** new `src/services/generation-site-config.ts`,
  `src/services/internal-api.ts`, `src/routes/internal.ts`,
  `src/services/starter-docs.ts`, `src/services/docs-content/service.ts`;
  new `tests/services/generation-site-config.test.ts` and
  `tests/services/starter-docs.test.ts`; updated
  `tests/services/docs-site-config.test.ts`.
- **generation:** `src/index.ts` forwards the config snapshot;
  `src/artifact-links.ts` uses the version-aware manifest parser;
  `tests/index.test.ts` verifies inline request propagation.
- **agent-worker:** `src/generation-workflow-runtime.ts` forwards settings and
  entitlements in both artifact finalization paths.
- **agent-container:** `src/index.ts`, `synthetic/runner.ts`,
  `tests/runtime-features.test.ts`, `tests/synthetic-generation-pipeline.test.ts`.
  The synthetic run exposes stored config for the preservation assertion.
- **docs-artifact-fixtures:** `scripts/create-set.ts`, new `scripts/recipe.ts`,
  new `tests/current-writer.test.ts`. No existing set was modified.
- **Documentation:** `docs/current/docs-artifact-compatibility.md` and this report.

### Verification commands and results

The combined commands below use pnpm filters to run the exact package scripts:

```bash
CI=true pnpm --filter @doxahq/site-config --filter @doxahq/docs-engine --filter @doxahq/docs-artifact-fixtures --filter @doxahq/contracts --filter @doxahq/generation --filter @doxahq/api --filter @doxahq/agent-worker --filter @doxahq/docs-runtime --filter @doxahq/docs-template test
CI=true pnpm --filter @doxahq/agent-container test --exclude '**/.workspaces/**'
pnpm --filter @doxahq/site-config --filter @doxahq/docs-engine --filter @doxahq/docs-artifact-fixtures --filter @doxahq/contracts --filter @doxahq/generation --filter @doxahq/api --filter @doxahq/agent-worker --filter @doxahq/agent-container --filter @doxahq/docs-runtime --filter @doxahq/docs-template typecheck
pnpm --filter @doxahq/docs-template build:cloudflare
git diff --check
git diff --name-only -- packages/docs-artifact-fixtures/sets
git diff --cached --name-only
git status --short
```

| Package/check | Result |
| --- | --- |
| site-config | 176 tests passed, including all section 13.1 attack tables |
| docs-engine | 48 tests passed |
| artifact fixtures | 44 tests passed, including 3 exact current-writer comparisons |
| generation | 77 tests passed |
| API | 627 tests passed |
| agent-worker | 110 tests passed |
| agent-container | 159 tests passed across all 23 Doxa test files |
| docs-runtime | 102 tests passed |
| docs-template | 246 tests passed |
| contracts test | Passed; its test script runs TypeScript |
| Typechecks | All 10 packages passed |
| Cloudflare renderer build | Passed; 29 local pages pre-rendered |
| Whitespace and fixture diff checks | Passed; no tracked frozen-file changes |
| Staging | Only the user's previously staged spec remains staged |

Total: **1,589 tests passed**. Logs are in `/tmp/doxa-phase4-final-tests.log`,
`/tmp/doxa-phase4-container.log`, `/tmp/doxa-phase4-final-types.log`, and
`/tmp/doxa-phase4-build.log`.

Intermediate failures were fixed rather than hidden: entitlement output needed
resolution before serialization; a Vitest 3 matcher was replaced with Vitest 2
assertions; manifest property order was aligned with frozen writer output;
the generation link checker was moved to the shared version-aware parser; and
writer-only tests now expect `site.json` rather than the retired `features.json`.
The initial container run also discovered six unrelated customer-repository test
files inside old `.workspaces` checkouts. The repeat run excludes that cache only;
it does not exclude any Doxa test file or change/delete the cached repositories.

Build warnings remain for local Node 25 versus requested Node 24, pnpm's old
`onlyBuiltDependencies` location, large chunks, TanStack `inputValidator()`
deprecations, and the existing gray-matter `eval` usage. They did not fail the build.

### Skips, differences, and decisions

- No live smoke test, deployment, migration, Docker image build, or paid-model
  generation ran. Production was not changed. The synthetic generation uses a
  local Git repository and mock models.
- No browser check ran: phase 4 adds no UI. Phase 5 browser and keyboard checks
  remain pending. The Graft CLI is unavailable, so no graph rebuild ran.
- The 120-character project name versus 80-character site name difference is
  resolved by the user's approval. The fallback for an all-control/blank derived
  name is the existing schema default, not an empty heading.
- The user-approved phase 2 fixture preparation is the exception to section 7.4's
  original timing. Phase 4 proves the active writer produces those exact bytes.
- The published version selects generation settings, even if incremental analysis
  uses an older baseline. A missing or cross-project manifest fails the job setup;
  valid manifests use the shared reader's specified integrity fallback behavior.
- No new dependency was installed in phase 4. No existing validation rule was
  duplicated and no user-edited name is silently shortened.

## Phase 1 requirements

| Requirement | Status | Evidence |
| --- | --- | --- |
| Separate primitive, area-schema, preset, resolver, parser, and CSS modules | Done | Package file list below |
| Zod-derived public types; no `any` or compiler-silencing assertions | Done | Package typecheck |
| Strict parsing with shared issue codes and JSON pointers | Done | `parse.test.ts`, `legacy-and-validation.test.ts` |
| Lenient parsing with bounded passes and valid sibling retention | Done | `parse.test.ts`, `bounds.test.ts` |
| CSS and link allowlists, text and asset validation | Done | `primitives.test.ts` |
| Size, nesting, and item limits | Done | `bounds.test.ts` |
| Default and brutalist presets, token map, curated font URLs | Done | `theme.test.ts` and snapshots |
| CSS second barrier and deterministic property-style coverage | Done | `theme.test.ts` |
| Legacy upgrade | Done | Missing, partial, complete, and invalid legacy feature tests |
| Pure entitlement enforcement | Done | Immutable input and free/paid cases |
| Canonical config hash | Done | Insertion-order independence and changed-value test |
| JSON Schema output | Done | Snapshot tests and complete CLI output parsed as JSON |
| Shared validation and entitlement contracts | Done | Contracts test and typecheck |

## Changed files by package

### @doxahq/site-config — new package

- `packages/site-config/package.json`
- `packages/site-config/scripts/emit-json-schema.ts`
- `packages/site-config/src/css.ts`
- `packages/site-config/src/entitlements.ts`
- `packages/site-config/src/fonts.ts`
- `packages/site-config/src/hash.ts`
- `packages/site-config/src/index.ts`
- `packages/site-config/src/json-schema.ts`
- `packages/site-config/src/legacy.ts`
- `packages/site-config/src/parse-theme.ts`
- `packages/site-config/src/parse.ts`
- `packages/site-config/src/presets/brutalist.ts`
- `packages/site-config/src/presets/default.ts`
- `packages/site-config/src/presets/index.ts`
- `packages/site-config/src/primitives/asset-ref.ts`
- `packages/site-config/src/primitives/css-color.ts`
- `packages/site-config/src/primitives/css-length.ts`
- `packages/site-config/src/primitives/font-family.ts`
- `packages/site-config/src/primitives/href.ts`
- `packages/site-config/src/primitives/plain-text.ts`
- `packages/site-config/src/primitives/theme-preset.ts`
- `packages/site-config/src/primitives/theme-tokens.ts`
- `packages/site-config/src/resolve.ts`
- `packages/site-config/src/schema/branding.ts`
- `packages/site-config/src/schema/features.ts`
- `packages/site-config/src/schema/footer.ts`
- `packages/site-config/src/schema/navbar.ts`
- `packages/site-config/src/schema/seo.ts`
- `packages/site-config/src/schema/site-config.ts`
- `packages/site-config/src/schema/theme.ts`
- `packages/site-config/src/tokens.ts`
- `packages/site-config/src/validation/drop-invalid.ts`
- `packages/site-config/src/validation/limits.ts`
- `packages/site-config/src/validation/link-warnings.ts`
- `packages/site-config/src/validation/messages.ts`
- `packages/site-config/src/validation/pointer.ts`
- `packages/site-config/src/validation/zod-issues.ts`
- `packages/site-config/tests/__snapshots__/legacy-and-validation.test.ts.snap`
- `packages/site-config/tests/__snapshots__/theme.test.ts.snap`
- `packages/site-config/tests/bounds.test.ts`
- `packages/site-config/tests/legacy-and-validation.test.ts`
- `packages/site-config/tests/parse.test.ts`
- `packages/site-config/tests/primitives.test.ts`
- `packages/site-config/tests/theme.test.ts`
- `packages/site-config/tsconfig.json`

### @doxahq/contracts

- `packages/contracts/package.json`: export validation and entitlement subpaths.
- `packages/contracts/src/validation.ts`: issue codes, JSON pointers, issues, and validation error schema.
- `packages/contracts/src/entitlements.ts`: entitlement schema and free-plan defaults.

### Workspace

- `pnpm-lock.yaml`: workspace dependencies and approved tsx 4.23.15. The install also updated optional tsx peer references.
- This implementation report.

## Verification

- `pnpm --filter @doxahq/site-config test`: passed, 166 tests in 5 files.
- `pnpm --filter @doxahq/site-config typecheck`: passed.
- `pnpm --filter @doxahq/contracts test`: passed.
- `pnpm --filter @doxahq/contracts typecheck`: passed.
- `pnpm --silent --filter @doxahq/site-config emit:json-schema`: complete output parsed as JSON; both schema IDs checked.
- `git diff --check`: passed.
- `git status --short`: inspected before edits and at handoff.

Phase 2 verification is recorded below. No active writer was flipped.
Browser checks are not applicable to phase 1.
Deployment and migration checks are deliberately skipped because they are not authorized.

The environment reports Node 25 although docs-template requests Node 24.
pnpm also reports the existing deprecated root `onlyBuiltDependencies` location.

## Security test evidence

### Test strategy

Gate 0 is off because the package has security-sensitive logic.
Gates 1 and 6 are on for validation and stable serialization properties.
Gates 2–5 are off for this phase: it has no external I/O, UI, separate deployment, or deployed endpoint.
The strategy deliberately uses no integration infrastructure for pure functions.

```yaml
test_strategy:
  artifact: packages/site-config
  rationale: Config values become CSS, links, and stored artifact data.
  criticality: HIGH
  selected_types:
    - rationale: Validate accepted values, rejected values, limits, and issue paths.
      type: unit
      size: small
      framework: vitest
      dependencies: []
      gate: Gate 1
    - rationale: CSS safety, canonical hashing, and resolution idempotency have stable invariants.
      type: property-based
      size: small
      framework: vitest
      dependencies: []
      gate: Gate 6
  rejected_types:
    - reason: Pure functions have no external I/O boundary.
      type: integration
    - reason: Phase 1 has no UI.
      type: component
    - reason: Phase 1 has no user journey.
      type: e2e
    - reason: Cross-service contracts are covered in phase 2.
      type: contract
    - reason: The package has no deployed endpoint.
      type: smoke
  deliberately_skipped:
    - why: Production changes are not authorized.
      what: Live deployment checks
```

Test cases cover sections 6 and 13.1:

- [unit] Accepted and rejected primitive values, including each required attack string.
- [unit] Numeric, text, count, depth, and byte-size boundaries.
- [unit] Strict issue codes and escaped JSON pointers.
- [unit] Lenient parsing retains valid siblings and removes invalid array items.
- [unit] Legacy upgrade and immutable entitlement enforcement.
- [unit] Preset CSS and JSON Schema snapshots.
- [property-based] Deterministic valid-token inputs produce no style terminator or unknown CSS variable.
- [property-based] Property insertion order does not change a config hash.
- [property-based] Resolving stored config again does not change its values.

`tests/primitives.test.ts` checks each CSS attack against both color and length schemas:

```text
;  {  }  <  >  \
/*  url(  image-set(  expression(  @import  var(
CSS escape: \75rl(
Non-ASCII lookalike: ｒｇｂ(1 2 3)
Style terminator: </style><script>alert(1)</script>
Trailing LF / CRLF
Values longer than 64 characters
```

The same suite rejects executable URL schemes, protocol-relative links, backslashes, whitespace,
unapproved fonts, and non-hash asset references.
Parser tests cover unsafe object keys, hostile input, and rejected-value suppression.

## Decisions and approved exceptions

- User approved the internal contracts dependency and the internal workspace dependencies for later phases.
- User selected tsx 4.23.15.
- User approved sibling schema composition, preset imports for theme defaults, and the validated font lookup in CSS output.
- User approved preparing v2 fixtures during phase 2 with a candidate writer. The active writer stays at v1 until phase 4.
- Explicit per-mode tokens take precedence over theme-wide primary/radius shortcuts. This preserves resolved config when parsed again.
- The Twitter handle uses the bounded plain-text schema with an 80-character limit. The spec does not prescribe a separate limit.

## Phase 2 compatibility exception — approved and implemented

Section 8.1 adds `siteConfig` to the internal `getRouteData` response.
The frozen runtime gate compares the entire response to an existing golden file.
Adding that field therefore changes the golden comparison, even if every existing field is identical.

The spec also requires a project-name title for legacy conversion.
However, the existing resolution contract contains only `projectSlug`, and the v1 goldens require the slug title
plus `Documentation for <slug>.`.
Changing these values conflicts with the requirement to keep old route data unchanged.

The user approved this resolution:

1. Preserve all existing v1 route-data values, including title and description.
2. Compare every old response field against the unchanged v1 golden.
3. Compare the new `siteConfig` field separately against the approved new `expected/site-config.json` golden.
4. Require the new field in the new reader tests, so it cannot disappear unnoticed.
5. Use project-name defaults for newly written v2 config.

No existing frozen file changed. The gate compares every old response field unchanged,
and separately requires and compares the new field. It does not discard an untested field.

## Phase 2 requirements

| Requirement | Status | Evidence |
| --- | --- | --- |
| Version-specific manifest schemas; supported versions `[1, 2]`; active writer remains 1 | Done | `docs-engine/src/manifest.ts`, `artifact-schema.ts`, engine tests |
| One injected shared reader for v1 conversion and v2 config | Done | `docs-engine/src/site-config-reader.ts` |
| Raw-byte SHA-256 integrity, safe object keys, lenient parsing, path-only warning logs | Done | Engine tests and changed-byte frozen-set runtime test |
| Isolate config LRU with 256 entries keyed by immutable prefix | Done | Runtime test covers reuse, recency, and eviction |
| New operation plus additive internal route data; stable public route-data contract | Done | Runtime goldens and renderer public route-data tests |
| Existing config operations retained | Done | Runtime projects site, features, company, social, and theme from the resolved config |
| Mixed-release fallback to legacy operations | Done | New renderer/old runtime tests plus preserved old runtime response fields |
| Published asset delivery through trusted host/version resolution | Done | Runtime and dispatcher asset tests |
| Private assets retain access gate and private cache policy | Done | Renderer gate-order and dispatcher/runtime tests |
| SVG sandbox, no-sniff, MIME allowlist, immutable public asset headers | Done | Runtime asset header test |
| Request-scoped config, root loader, provider, SSR CSS, fonts, metadata, chrome | Done | Renderer build, customized component SSR test, one-shot request test |
| Shared live-render and prerender configuration path | Done | Prepared server test and local pre-render build |
| Static imports removed; local `doxa.json` source | Done | Source inspection and renderer build |
| CSS memoization by config hash; client SEO omission | Done | `theme-style.tsx`, `client.ts` |
| Customized dehydrated root payload under 8 KiB | Done | Renderer payload test, including config/hash/head/delivery fields |
| Existing v1 frozen files unchanged | Done | Empty `git diff --name-only -- packages/docs-artifact-fixtures/sets` |
| New v1 config goldens and v2 candidate fixtures | Done | All three compatibility suites with `CI=true` |

### Phase 2 changed files by package

- **Contracts:** `src/docs-prerender.ts` exports the shared hash schema and object-key guard. The hash schema also rejects a trailing newline.
- **Site config:** `src/assets.ts`, `src/client.ts`, and public exports provide asset paths and the client projection. Theme resolution gives explicit tokens precedence so stored resolved config is idempotent.
- **Docs engine:** package dependency wiring, `src/artifact-schema.ts`, `src/manifest.ts`, `src/index.ts`, new `src/site-config-reader.ts`, and `tests/site-config-reader.test.ts`.
- **Artifact fixtures:** dependency wiring, `recipes/customized/`, three new v1 `expected/site-config.json` files, and the three new `sets/schema-v2/` sets. No existing frozen file changed.
- **Docs runtime:** dependency wiring, `src/index.ts`, `src/runtime-source.ts`, new `src/site-config.ts`, new `src/site-assets.ts`, and `tests/artifact-schema-compat.test.ts`.
- **Docs dispatcher:** `src/index.ts`, new `src/site-assets.ts`, and new `tests/site-assets.test.ts`.
- **Docs template, config:** new `src/site-config/` modules and test, new `src/contents/doxa.json`, and dependency wiring.
- **Docs template, readers:** `src/runtime/{runtime-source,binding-runtime-source,platform-runtime-source,vite-runtime-source,request-context}.ts` and new `runtime-source-error.ts`.
- **Docs template, rendering:** `src/server.ts`, `src/server.test.ts`, `src/routes/__root.tsx`, both `llms*.txt` routes, providers, navigation chrome, pagination, section tabs, sidebar preloading, TOC, feedback, theme toggle, chat API, agent prompt, raw markdown and its tests, preload policy, and Open Graph types.
- **Removed obsolete tracked modules:** `settings/main.ts`, `settings/theme.ts`, `contents/settings/theme.json`, `schemas/theme.schema.json`, `lib/colors.ts`, and `lib/themes.ts`. Their live consumers now use the resolved config. Git retains the previous versions.
- **Workspace:** approved internal dependencies in `pnpm-lock.yaml` and this report.

### Phase 2 verification commands

| Command | Result |
| --- | --- |
| `pnpm --filter @doxahq/site-config test` | Passed: 166 tests |
| `pnpm --filter @doxahq/site-config typecheck` | Passed |
| `pnpm --filter @doxahq/contracts test` | Passed (package script runs TypeScript) |
| `pnpm --filter @doxahq/contracts typecheck` | Passed |
| `pnpm --filter @doxahq/docs-engine test` | Passed: 43 tests |
| `pnpm --filter @doxahq/docs-engine typecheck` | Passed |
| `CI=true pnpm --filter @doxahq/docs-artifact-fixtures test` | Passed: 41 tests |
| `pnpm --filter @doxahq/docs-artifact-fixtures typecheck` | Passed |
| `CI=true pnpm --filter @doxahq/docs-runtime test` | Passed: 102 tests |
| `pnpm --filter @doxahq/docs-runtime typecheck` | Passed |
| `CI=true pnpm --filter @doxahq/docs-template test` | Passed: 246 tests |
| `pnpm --filter @doxahq/docs-template typecheck` | Passed |
| `pnpm --filter @doxahq/docs-dispatcher test` | Passed: 163 tests |
| `pnpm --filter @doxahq/docs-dispatcher typecheck` | Passed |
| `pnpm --filter @doxahq/mdx-runtime build` | Passed (renderer build prerequisite) |
| `pnpm --filter @doxahq/docs-template build` | Passed: client/SSR build and 29 locally pre-rendered pages |
| Scoped Prettier over changed source files | Passed when run from the template package; root invocation could not resolve its plugins |
| `git diff --check` | Passed |
| `git status --short` | Inspected before edits and at the checkpoint |

Intermediate failures were corrected: one test used a matcher unavailable in Vitest 2,
and a test closure needed a guaranteed fixture rather than an optional lookup.
No assertion or existing golden was weakened to resolve either failure.

Build warnings remain: local Node 25 versus the requested Node 24, existing large chunks,
TanStack `inputValidator` deprecations, and the existing gray-matter `eval` warning.
No browser or production smoke check ran. This checkpoint covers deterministic reader
tests and the local build; the phase 5 keyboard/browser checks remain pending.
The Graft CLI is unavailable, so no graph rebuild ran. Existing graph cards were inspected.

### Phase 2 test strategy

Gates 0 and 6 are off here: these additions have behavior, but the new branch spaces are finite.
Gates 1–4 are on for parsing, storage isolation, SSR output, and independently deployed readers.
Gate 5 applies to deployment, but live smoke tests are not authorized.

```yaml
test_strategy:
  artifact: Site config readers and published asset delivery
  rationale: Immutable configuration crosses runtime, renderer, and dispatcher boundaries.
  criticality: HIGH
  selected_types:
    - rationale: Cover integrity fallback, access decisions, and cache eviction.
      type: unit
      size: small
      framework: vitest
      dependencies: [in-memory R2 objects]
      gate: Gate 1
    - rationale: Feed frozen artifacts through the actual runtime reader.
      type: integration
      size: medium
      framework: vitest
      dependencies: [local frozen fixtures]
      gate: Gate 2
    - rationale: Verify customized production chrome and inline theme output.
      type: component
      size: medium
      framework: vitest and React server rendering
      dependencies: [customized fixture, peripheral UI stubs]
      gate: Gate 3
    - rationale: Preserve old fields and mixed-release behavior across deployments.
      type: contract
      size: medium
      framework: vitest
      dependencies: [frozen goldens, binding protocol test doubles]
      gate: Gate 4
  rejected_types:
    - reason: Integration and component tests cover the phase 2 acceptance cases.
      type: e2e
    - reason: New asset routing and cache cases have finite decision tables.
      type: property-based
  deliberately_skipped:
    - why: Deployment and remote mutation are not authorized.
      what: Production smoke tests
```

Tests cover spec sections 13.2 and 13.3: unchanged v1 outputs, v2 goldens,
changed-byte fallback, new/old runtime compatibility, SSR chrome, payload size,
unreferenced and cross-site assets, and required security headers.

### Candidate fixture provenance

The candidate writer lives in the isolated local directory `/tmp/doxa-v2-writer.eA7D0q`.
At the phase 2 checkpoint, only that copy used writer schema version 2. Its
`create-set` script generated the starter, component-showcase, and customized
artifacts. In phase 4, the active writer changed to 2. The new current-writer
test reproduces every artifact byte in those sets, without editing frozen files.

### Phase 3 approval

Phase 3 is complete. No commit, migration, or deployment was performed.

| Requirement | Status | Evidence |
| --- | --- | --- |
| Shared config edit contracts and overview | Done | `contracts/src/docs-content.ts`, HTTP validation tests |
| Config draft overlay and reset | Done | `docs-content/site-config.ts`, config-only and page-preserving reset tests |
| Entitlement DI and publish recheck | Done | Interface, free implementation, downgrade test |
| Full issue responses and stale draft code | Done | HTTP 422 tables and 409 assertion |
| Raw config byte limits | Done | Escaped keys, UTF-8, boundary, stream tests |
| Uploads, previews, ownership, sanitization | Done | 42 asset service and HTTP tests |
| v1-to-v2 publication upgrade | Done | Real service exercised with candidate writer version 2 |
| Asset retention rule | Done | `docs/current/storage-garbage-collection.md` |

Changed API areas: content service, composition, validation, bounded body reader,
asset store/sanitizer/service/routes, project ownership lookup, and tests.
Changed shared packages: contracts DTOs, site-config asset kinds/limits, and
docs-engine draft metadata. Updated the lockfile and storage GC documentation.

Verification: API 616 tests, site-config 166, docs-engine 43, fixtures 41,
runtime 102, renderer 246. All passed. API, contracts, site-config, and docs-engine
typechecks passed. The final config/asset checks passed again after the storage
guards. `git diff --check` passed. Existing frozen files remain unchanged.

Implementation choices not specified in detail: uploads use multipart `file` and
`kind` fields. Warnings are an optional `warnings` array in the upload response.
Asset kind is stored in R2 custom metadata. A repeated hash skips the write;
uploading the same hash under another kind returns `asset_wrong_kind` instead of
silently changing its metadata. Runtime delivery does not depend on that metadata.
Until phase 4 activates the writer, config-only publication returns an explicit
error rather than publishing a v1 artifact that discards the config.

SVG uploads need a real XML parser before the allowlist sanitizer can walk and rebuild the document.
Proposed new API dependency: `@xmldom/xmldom` 0.9.12 (registry lookup on 2026-09-24).
The package provides parsing and serialization, not sanitization. The API still owns
the spec's element/attribute allowlist, local-fragment checks, size limits, and attack tests.
The user approved this dependency. Installed `@xmldom/xmldom` 0.9.12 in the API.

### Phase 3 verification plan

Gates: 0 off (security logic), 1 on (parsing), 2 on (HTTP/storage),
3 off (no UI), 4 on (independent dashboard), 5 on but skipped (no deployment
approval), 6 on (sanitizer idempotence). Pure validators need no database.

```yaml
test_strategy:
  artifact: API site config edits and assets
  rationale: Protect project isolation and immutable publication.
  criticality: HIGH
  selected_types:
    - rationale: Attack tables and boundary values cover validation and sanitizing.
      type: unit
      size: small
      framework: vitest
      dependencies: []
      gate: Gate 1
    - rationale: Real services share in-memory storage with HTTP adapters.
      type: integration
      size: medium
      framework: vitest
      dependencies: [in-memory storage, session and database boundary doubles]
      gate: Gate 2
    - rationale: Responses must preserve issue codes across separate deployments.
      type: contract
      size: small
      framework: vitest
      dependencies: [shared schemas]
      gate: Gate 4
    - rationale: Sanitized SVG output must remain unchanged by another pass.
      type: property-based
      size: small
      framework: vitest
      dependencies: [deterministic generated SVG values]
      gate: Gate 6
  rejected_types:
    - reason: No UI in phase 3. HTTP tests cover these paths.
      type: component
    - reason: HTTP integration tests cover the required behavior locally.
      type: e2e
  deliberately_skipped:
    - why: Deployment and remote mutation are not authorized.
      what: Production smoke tests
```

Tests to cover section 13.4:

- [unit] SVG script, event, foreign namespace, URL, entity, and CSS attacks.
- [unit] Upload sizes at limit minus one, limit, and limit plus one for each kind.
- [property-based] SVG serialization is idempotent for generated safe shapes.
- [integration] Non-owner uploads and previews cannot access another site's assets.
- [integration] Draft config reset preserves page edits. Config-only drafts persist.
- [integration] A stale draft gives 409. A plan downgrade blocks publication.
- [integration] A v1 publication in v2 writer mode emits config with the correct hash.
- [contract] Invalid config responses contain all issue codes and no rejected values.

## Phase 5 completion report

Phase 5 is complete. No commit, deployment, or migration was performed. A local
browser check ran against the local API and the local database only.

### Requirements

| Requirement | Status | Evidence |
| --- | --- | --- |
| 9.1 Reusable code editor | Done | `components/code-editor/*`. The MDX editor is a wrapper with the same props and look. |
| 9.2 Reusable draft buffer | Done | `lib/dashboard/use-draft-buffer.ts`. The content editor uses it with no behavior change. |
| 9.3 Settings dialog in the content editor | Done | Toolbar button, lazy dialog, seven tabs, close and reset confirmations. |
| 9.4 Client contracts | Done | `set_site_config`, `reset_site_config`, entitlements, and the upload DTO are used. |
| 10.1–10.3 Rule placement and issue model | Done | Shared rules from `@doxahq/site-config`. Server issues through `ApiValidationError`. |
| 10.4 Client error handling | Done | `lib/api-errors.ts`. Existing callers keep `message`. |
| 10.5 Issue display | Done | Blur gating, `aria-invalid`, `aria-describedby`, tab badges, summary, "Go to" and "Show in JSON". |
| 10.6 Entitlement gate | Done | "Paid plans" badge. A locked switch can turn the mark on, not off. |
| 13.5 Dashboard tests | Done | 73 new web tests: hook, model, JSON language, API errors, dialog in jsdom. |

### Decisions not specified in detail

- **Editable theme.** The API stores the resolved config, which pins every
  preset token. `toEditableSiteConfig` in `@doxahq/site-config` reduces the theme
  to real overrides, so preset and primary color changes take effect. It
  resolves back to the same config (round-trip tests).
- **No TanStack Form.** The form and the JSON tab edit one object in the draft
  buffer. A second form state would need a sync layer. Field validation runs the
  shared strict parse on each change, which the spec requires anyway.
- **Language as an extension prop.** `CodeEditor` takes a CodeMirror extension,
  not a `{ kind }` union, so the JSON code stays out of the MDX chunk.
- **Small JSON editor dependencies.** User-approved: `@codemirror/lang-json`,
  `@codemirror/lint`, `@codemirror/autocomplete`. Completion and hover read
  `siteConfigJsonSchema()`. `codemirror-json-schema` was rejected for size.
- **DOM test dependencies.** User-approved dev dependencies: `jsdom`,
  `@testing-library/react`, `@testing-library/dom`, `@testing-library/user-event`.
  Only files with `// @vitest-environment jsdom` use the DOM.
- **Summary visibility.** The issue summary lists only visible issues (touched,
  after a save attempt, or from the server). The footer always states why a
  save waits.
- **Hidden flags.** `features.branding`, `loadFromGithub`, and
  `AgressiveNavPrefetch` change nothing on a published site. The form hides them.

### Changes to shared code outside `apps/web`

- `packages/site-config`: added `editable.ts` and its tests. Added
  `requiredTextSchema`: link labels, the CTA label, footer group titles, and
  keywords now reject empty text with the `required` code. An empty label
  rendered an invisible link. The JSON Schema snapshot gained five
  `minLength: 1` entries, as the spec requires for a schema change.
- `zod-issues.ts`: a string minimum of 1 maps to `required`. Other minimums keep
  the fallback, so the existing unmapped-issue test is unchanged.

### Verification commands and results

- `pnpm --filter @doxahq/web typecheck`: pass.
- `pnpm --filter @doxahq/web test`: 210 passed.
- `pnpm --filter @doxahq/web build`: pass.
- `pnpm --filter @doxahq/site-config test`: 189 passed. Typecheck pass.
- Compatibility suites after the schema change: fixtures 44, runtime 102,
  renderer 246 passed. `docs-engine` 48 and API 627 passed. Typechecks pass.
- Browser check (Chrome, local API and web): open, edit, autosave, theme
  preview, contrast warning, JSON lint, unknown key, "Show in JSON", "Go to
  Theme", close guard, SVG upload with sanitizing, reload round trip, reset. No
  console errors.

### Findings for follow-up

- **Main bundle size.** `@doxahq/contracts` (root) now imports
  `@doxahq/site-config` for the overview DTO. Every dashboard route loads it:
  the `platform-api` chunk grew from 7.7 kB to 15.3 kB gzip (measured against a
  build of `4de2d44`). Recommendation: move the site config DTOs to a subpath
  export, for example `@doxahq/contracts/docs-content`.
- **Server message grammar.** `validationError()` says "The site settings have
  1 errors." The dashboard hides this banner and opens the dialog instead.
- **Radix dialog font.** Every dashboard dialog inherits the mono body font,
  because the portal renders outside the shell. The settings dialog sets
  `font-sans` locally. Other dialogs were left unchanged.
- Unrelated fix: removed an unused `PenLine` import in `generation-welcome.tsx`,
  which failed the web typecheck on `4de2d44`.
