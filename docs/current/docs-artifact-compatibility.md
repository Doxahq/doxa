# Docs Artifact Compatibility

**Status:** Manifest version checks and frozen-fixture suites are implemented. Production component coverage is deferred. Canary rollout is planned, not built.
**Last reviewed:** 2026-09-30

This document is the contract between the docs writers and the docs renderer.
Every agent and engineer who changes the renderer, the runtime, the artifact
writers, or the artifact shape must follow it.

For the rendering flow, see
[Production Docs Rendering](./production-docs-rendering.md). For the artifact
layout and the identity values, see
[Production Docs Content Injection](./production-docs-content-injection.md).

## The Two Rules

After the first schema v2 artifact exists, every reader must be at least the
phase 2 release of the site-config implementation. A rollback must retain both
v1 and v2 readers. Reverting only the writer cannot make a v2 artifact readable
by an older reader. The v2 fixtures were prepared with a candidate writer during
phase 2 with explicit approval; phase 4 adopts that writer without changing any
frozen artifact or golden file.

### Rule 1: The renderer is evergreen

The selected renderer release applies to every production site. No site pins
an older renderer build. The dispatcher, shared renderer, and docs runtime
are separate deployments. They can temporarily use different releases during
an upgrade or an incomplete rollback.

The build ID and the release ID are global Worker variables. They are not
stored on a published version. See
`apps/docs-dispatcher/src/index.ts`.

Consequences:

- A renderer deploy is a change to every live customer site at once.
- A complete rollback coordinates the affected services. It is global.
- The renderer must read every artifact set that Doxa ever published.

### Rule 2: Breaking changes go to the write side, never the read side

The write side is every code path that creates an artifact set:

- `createRuntimeDocsArtifacts` and `createStarterDocsManifest` in
  `packages/docs-engine`;
- the generation pipeline in `packages/generation` and `apps/agent-worker`;
- the starter publication and the draft publication in `apps/api`.

The read side is every code path that consumes an artifact set:

- `apps/docs-runtime` (the private content runtime);
- `apps/docs-template` (the public renderer);
- the content editor service in `apps/api`;
- the pre-render Worker in `apps/docs-prerenderer`.

The read side must accept every artifact schema version in
`SUPPORTED_DOCS_ARTIFACT_SCHEMA_VERSIONS`. The write side stamps
`DOCS_ARTIFACT_SCHEMA_VERSION` into every new manifest. Both constants live in
`packages/docs-engine/src/artifact-schema.ts`.

A customer receives a new content shape only when the customer republishes.
That is the on-demand upgrade. It never requires a renderer pin.

## The Schema Version

`manifest.json` carries `schemaVersion`, a positive integer.

- A manifest without the field is schema version 1. Every manifest published
  before 2026-09-23 has no field.
- `parseDocsManifest` and `parseDocsManifestText` validate the version field
  before the payload. They return `unsupported_schema_version` for a newer
  version, even when its required fields differ from the current shape.
- A malformed version field returns `invalid_manifest`. A missing field
  selects version 1, whose payload must still pass validation.
- `docsManifestSchema` validates the current manifest shape but does not
  enforce the supported-version list by itself.
- Every reader must use one of those two functions. Direct use of
  `docsManifestSchema.safeParse` on a stored manifest is forbidden.

When the docs runtime meets an unsupported version:

- `runResolvedRuntimeRequest` returns the error code
  `unsupported_artifact_schema` and a message with both version lists.
- The host and project paths return the same code with HTTP status 500.
- The runtime writes one structured log with the event
  `docs_artifact_schema_unsupported`.

This case is a deploy-order bug. The renderer must always deploy before a
writer that produces a new schema version.

## The Storage Format

The schema version describes the content of an artifact set. The storage
format describes how that content is stored in R2. See
[Docs Content Storage](./docs-content-storage.md).

- Each version folder holds one `tree.json` with `formatVersion`. The tree maps
  each artifact path to a content-addressed blob.
- Readers must accept every format version in
  `SUPPORTED_VERSION_TREE_FORMAT_VERSIONS`. A new format version follows the
  same two-stage order as a new schema version: readers first, then writers.
- Readers resolve logical keys through the tree. They never read a blob key
  that they built themselves.

### One-time exception: flat folders (2026-09-30)

Before 2026-09-30, a version folder held flat files. The user approved one
exception to Rule 1 for this layout change. Doxa had no external users, so the
readers drop support for flat folders after the migration converts every
existing folder. The contract applies again to the tree format from that
point.

The exception covers only the storage layout:

- Schema versions 1 and 2 stay supported. No frozen set and no golden file
  changed.
- The gate harness now stores each frozen set as a tree with the real writer.
  An identical golden output proves that the layout change does not change
  what a site renders.
- Production was migrated on 2026-09-30. Readers no longer read flat
  folders.

## The Compatibility Gate

The gate is a set of frozen artifact sets and three test suites.

### Frozen artifact sets

The sets live in `packages/docs-artifact-fixtures/sets/schema-v{N}/{name}/`.
Each set holds:

- `set.json`: the identity of the set;
- `artifacts/**`: the artifact objects, byte for byte;
- `expected/**`: golden outputs of the current readers.

A frozen set never changes after it is added. A change to `artifacts/**`
weakens the gate. The loader refuses a set whose folder does not match its
declared name and schema version.

Schema version 1 has three sets:

| Set                  | Purpose                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| `starter`            | The two-page starter site with flat navigation.                        |
| `component-showcase` | Two sections, grouped navigation, every MDX component, one API page.   |
| `legacy-unversioned` | A manifest without `schemaVersion`, as published before the field.     |

### Test suites

| Suite                                                            | What it proves                                                                                              |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `packages/docs-artifact-fixtures/tests/index.test.ts`            | Every supported version has a frozen set. Every set is complete and pinned to its own identity.             |
| `apps/docs-runtime/tests/artifact-schema-compat.test.ts`         | The runtime turns every set into the same route data, sections, navigation, features, and pre-render plan. It reads each set from a version tree. |
| `apps/docs-template/src/runtime/artifact-schema-compat.test.ts`  | Each page parses and produces nonempty HTML with the portable component registry. The component names per page are fixed. |

The runtime suite writes the golden route data. The template suite reads it.
Run the runtime suite first when a golden file is missing.

### Deferred decision: production component compatibility coverage

**Decision date:** 2026-09-23. The user deferred this change for further review.
The current template suite remains unchanged.

The suite uses the portable component registry. It checks nonempty HTML and
component names, but does not compare production component output or behavior.
The existing registry comparison checks names only. A production component can
lose support for a prop while these checks still pass.

The proposed extension is to render frozen pages with the production registry
and its required providers. Targeted assertions can cover card descriptions,
links, note variants, and file labels. Browser checks can cover tabs, folder
expansion, and Mermaid diagrams.

This proposal is not an approved implementation plan. Before implementation,
decide which user-visible behaviors must remain stable and which visual changes
are acceptable. Compare the maintenance cost of semantic assertions, HTML
snapshots, and browser checks. Full HTML snapshots can fail on harmless markup
or class changes. Keep old artifacts fixed regardless of the selected approach.

Revisit this decision before relying on the gate as proof of production UI
compatibility, or when a production component regression escapes the current
tests. The gate currently proves only the narrower behaviors in the table.

### When a gate fails

1. Assume the reader regressed. Fix the reader so that old artifacts render as
   before.
2. Never edit a frozen set, delete a golden file, or relax an assertion to make
   the suite pass.
3. If the new output is a wanted behavior change, get explicit approval from
   the user first. Then regenerate the golden files with `vitest run -u` in
   the affected app and review every diff in the pull request.

## How To Add A Schema Version

Reader support and writer output are independent. For example, readers can
support `[1, 2]` while `DOCS_ARTIFACT_SCHEMA_VERSION` stays `1`. The writer
version must be supported, but need not be the highest supported version.
Unsupported-version tests use the highest supported version plus one.

Prepare two changes: reader support with new fixtures, then writer activation.
Do not deploy the candidate writer during fixture preparation.

1. Add the new supported version and its reader implementation. Keep all old
   formats readable. Keep the deployed writer default unchanged.
2. Prepare the candidate writer and its recipe in a separate local checkout.
   Set the new writer version only in that checkout.
3. Run `pnpm --filter @doxahq/docs-artifact-fixtures create-set <recipe>` there.
   The script uses the actual candidate writer, not a relabeled old artifact.
4. Copy the new recipe and `sets/schema-v{N}/` directory into the reader change.
   Do not copy the candidate writer activation or modify old sets.
5. Create the new golden files with the reader suites and review their output.
   Run the runtime suite before the template suite. Then run all three
   compatibility suites with `CI=true` so missing snapshots fail verification.
6. Commit the readers and complete new fixtures together. Deploy all readers,
   including the private docs runtime and API content reader. Verify their
   support before activating any writer. Old writers still emit the old format.
7. Activate the candidate writer in a separate change. Run all compatibility
   suites again. Verify that its output matches the new format before deployment.

The inventory gate must require fixtures for every supported version during
both stages. Do not bypass it to deploy reader support without new fixtures.
The current fixture script only uses the current writer. A version flag that
only changes the manifest number is not a format conversion.

## Rollout And Rollback

- Deploy order for a renderer change: shared renderer, code package upload,
  dispatcher, pre-render Worker, API. See
  [Production Docs Content Injection](./production-docs-content-injection.md).

### Renderer rollback without a content-format change

A dispatcher-only rollback selects the previous Dynamic Worker package. It
does not restore the separately deployed shared renderer or docs runtime.
Shared traffic and fallback requests can still execute newer code.

1. Identify the last compatible release and the service versions that changed.
   Verify that the previous renderer package and its client assets remain available.
2. Restore the matching shared renderer and dispatcher package configuration.
   Restore the docs runtime only if it changed and remains compatible with all
   published artifact versions.
3. Align `DOXA_RENDERER_RELEASE_ID` across the dispatcher, API, and pre-render
   Worker. Keep the dispatcher build ID, package key, and client assets from
   the same release. Use the coordinated release configuration validation.
4. Verify Dynamic Worker rendering, shared fallback, and saved HTML delivery.
   Verify client navigation through the route-data endpoint as well.

These deployments are not atomic. Existing pre-render tasks can refer to the
newer release during rollback. Verify task reconciliation and retry behavior
after the service release identities agree. A successful dispatcher deployment
alone does not prove a complete rollback.

### Rollback after a content-format change

If any writer emitted a new artifact version, every active reader must retain
support for that version. Stopping the new writer does not remove its artifacts.
Older generations and previews can still refer to them.

Restore an older renderer only if it supports every published format. Otherwise,
keep the newer reader support and fix the regression in a new release. A tested
backport of that support is another option. Do not relabel stored artifacts or
remove a supported version to make an older release pass validation.

### Planned: canary rollout

A canary rollout is not built. Today one `DOXA_RENDERER_BUILD_ID` applies to
every site.

The planned change adds a second build ID for the sites in
`DOXA_PROD_DYNAMIC_RENDERER_SITE_IDS`. The dispatcher picks the build ID after
it resolves the hostname. The Dynamic Worker ID already contains the build ID,
so two builds never share an isolate. The HTML cache key and the pre-render
release ID must also carry the selected build.

Until that exists, treat every renderer deploy as a full rollout and run the
compatibility gate before it.

## Main Files

- `packages/docs-engine/src/artifact-schema.ts`
- `packages/docs-engine/src/manifest.ts`
- `packages/docs-artifact-fixtures/src/index.ts`
- `packages/docs-artifact-fixtures/scripts/create-set.ts`
- `apps/docs-runtime/src/runtime-source.ts`
- `apps/docs-runtime/tests/artifact-schema-compat.test.ts`
- `apps/docs-template/src/runtime/artifact-schema-compat.test.ts`
