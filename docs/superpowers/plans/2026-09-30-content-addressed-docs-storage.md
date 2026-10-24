# Content-Addressed Docs Storage

**Status:** Phases 0 to 4 complete in production on 2026-09-30. Phase 5 is
implemented and deployed. The change is not committed yet.
**Date:** 2026-09-30
**Branch:** `feat/content-addressed-storage`

## Decision

Doxa stores each published docs version as a full copy of every file. A merge
into `main` copies the complete site, even when one page changed.

The new layout stores each unique file once, under its SHA-256 hash. A version
becomes one small tree file that maps each path to a hash.

The user approved a one-time exception to the artifact compatibility contract
on 2026-09-30. Doxa has no external users, so the readers will not keep
support for the old flat layout. The exception applies to the **storage
layout** only:

- Readers drop the flat layout after the migration.
- Readers keep manifest schema versions 1 and 2. The frozen fixture sets and
  the golden files do not change.
- From the new layout on, the contract applies again. Every tree format
  version stays readable.

## Current Layout

```text
sites/{siteId}/versions/{versionId}/manifest.json
sites/{siteId}/versions/{versionId}/settings/*.json
sites/{siteId}/versions/{versionId}/source/**/index.mdx
sites/{siteId}/versions/{versionId}/search/*.json
```

- A publish writes every file to a new folder.
- The database row of a version stores `artifact_prefix` and `manifest_path`.
- Readers build a key as `{artifactPrefix}/{path}` and read it from R2.

## New Layout

```text
sites/{siteId}/versions/{versionId}/tree.json   one per version
sites/{siteId}/blobs/{sha256}                   one per unique file content
```

`tree.json` has this shape:

```json
{
  "format": "doxa-version-tree",
  "formatVersion": 1,
  "siteId": "…",
  "versionId": "…",
  "files": {
    "manifest.json": {
      "sha256": "64 lowercase hex characters",
      "size": 812,
      "contentType": "application/json; charset=utf-8"
    }
  }
}
```

Rules:

1. A blob key is `sites/{siteId}/blobs/{sha256}`. The hash is the SHA-256 of
   the exact bytes. Blobs never change.
2. Blobs belong to one site. The runtime reads only blobs under the resolved
   `siteId`. This keeps the isolation rule: a reader never reads outside the
   resolved site.
3. A writer writes all blobs first and `tree.json` last. A version without a
   tree does not exist for readers.
4. The database row is created after `tree.json` exists. This order is the
   same as today.
5. Each path in a tree must be a safe relative path: no leading `/`, no `..`,
   no `\`, no empty segment. The hash must be 64 lowercase hex characters.
6. `tree.json` is a reserved name. No artifact path can be `tree.json`.

## Key Design Choice: the Logical Key Space Stays

All readers keep the logical key `{artifactPrefix}/{path}`. Only the bottom
storage layer changes. That layer turns a logical key into a tree lookup and a
blob read.

Because of this choice:

- `docs_versions.artifact_prefix` and `manifest_path` keep their values. No
  database migration is necessary.
- `artifactIdentity` and `renderId` do not change. Saved pre-rendered HTML stays
  valid. No renderer deploy is necessary.
- A promotion that reuses an older folder keeps working. The tree is in that
  folder.
- Tests that use an in-memory logical store stay valid.

## Components

### 1. Shared storage module (`packages/docs-engine/src/version-tree.ts`)

- The tree schema, the key helpers and the path and hash validation.
- `sha256Hex(bytes)` with `crypto.subtle`.
- `createVersionTreeBucket(bucket, options)`: an adapter over a minimal R2
  interface.
  - `get(key)` resolves a logical version key through the tree. Other keys pass
    through unchanged.
  - `listVersionKeys(prefix)` lists the logical keys of one version from the
    tree. No R2 list call is necessary.
  - Trees are immutable, so the adapter keeps a bounded cache of parsed trees.
    It never caches a missing tree.
  - During the migration only, the option `legacyFlatFallback` reads the flat
    key when a version has no tree. Phase 5 removes this option.
- `VersionTreeWriter`:
  - `put(path, content, contentType)` hashes the content. It uploads the blob
    only when no known tree already holds that hash.
  - `copy(path)` copies an entry from the base tree without any read.
  - `commit()` validates the tree and writes `tree.json`.

### 2. API (`apps/api`)

- `createR2DocsContentStore` keeps its logical interface. Its R2
  implementation uses the adapter. All services keep their code.
- A new physical store serves the garbage collector and the migration. These
  two parts work with real keys.
- The materializer (branch publish and branch preview) uses
  `VersionTreeWriter` with the base tree:
  - Unchanged files: tree entries are copied. No read, no write.
  - Changed files: new blobs are written.
  - The effect: a merge writes only the changed pages, the manifest, the
    navigation and the search files.
- The starter publication and the container generation (`packages/generation`)
  use the writer.
- The internal artifact routes (`/internal/docs-artifacts`,
  `readDocsArtifact`) and `generation-site-config` read through the adapter.

### 3. docs-runtime (`apps/docs-runtime`)

- Every `DOCS_BUCKET.get` for artifacts goes through the adapter:
  `runtime-source.ts`, `index.ts` and `site-config.ts`.
- Site assets (`sites/{siteId}/assets/*`) stay outside the adapter.
- The tree cache lives per isolate. One cold request costs one more R2 read for
  the tree.

### 4. Generation Worker (`apps/agent-worker`)

- The two finalization blocks write through `VersionTreeWriter`.
- `loadReusablePages` reads baseline pages through the adapter. The generation
  state keeps its logical `artifactKey` values.

### 5. Garbage collection

- The version collectors (`docs_preview_version`, `docs_orphan_version_prefix`)
  delete the physical keys under the folder. After the migration, the folder
  holds only `tree.json`.
- After a folder is collected, the collector enqueues the new target
  `docs_site_blobs` for the site.
- The `docs_site_blobs` collector is a mark-and-sweep for one site:
  1. It lists every `tree.json` under `sites/{siteId}/versions/`.
  2. It parses each tree. If one tree is not valid, it stops and deletes
     nothing.
  3. It lists `sites/{siteId}/blobs/`.
  4. It deletes a blob only when no tree references it and the blob was
     uploaded more than one hour ago. A publish finishes in minutes, so the hour
     protects blobs that a running publish uploaded before its tree exists.
  5. If a young blob has no reference, the entry comes back after one hour.
- Invariant: a writer copies entries only from a tree that the collector keeps.
  Today the base of a publish is always a production version or a branch base.
  The collector never deletes these trees.

### 6. Migration tool (admin API routes)

The routes use `withAdminUser`. Each call handles a bounded number of versions
and returns the rest as `remaining`, so each call stays under the Worker
subrequest limit.

| Route | Effect |
|---|---|
| `POST /admin/storage/version-trees/inventory` | Lists every version folder in R2 and in the database. Read-only. |
| `POST /admin/storage/version-trees/backfill` | For each database folder without a tree, reads the flat files, writes the blobs and writes `tree.json` last. Supports `dryRun`. Idempotent. |
| `POST /admin/storage/version-trees/verify` | For each folder, checks the tree, checks that each blob exists and that each flat file has the same hash. Read-only. |
| `POST /admin/storage/version-trees/prune-legacy` | Deletes the flat files of a folder only when that folder passes the checks of `verify`. Supports `dryRun`. |

Folders shared by several versions (promotions) are converted once.

### 7. Compatibility gate

- The runtime gate harness stores each frozen set as blobs and a tree, with the
  real writer. The runtime then reads the set through the real adapter.
- The frozen sets and the golden files do not change. An identical golden
  output proves that the storage change does not change what a site renders.
- `docs/current/docs-artifact-compatibility.md` records the exception and the
  new storage format rule.

## Rollout

The deploy set is docs-runtime, the API and the generation Worker. The
renderer (dispatcher, shared renderer, pre-renderer) does not change.

| Phase | Action | Old code can still read? |
|---|---|---|
| 0 | Local: implement, run all tests, run the migration on local data, check local sites. | Yes |
| 1 | Deploy docs-runtime, then the API, then the generation Worker. Readers use the tree first and the flat key as a fallback. Writers write trees only. | Old versions: yes. New versions: no |
| 2 | Run `inventory`, then `backfill` with `dryRun`, then `backfill`. | Yes |
| 3 | Run `verify`. It must report zero problems. | Yes |
| 4 | Run `prune-legacy` (ask the user first, because this step is not reversible). | No |
| 5 | Remove `legacyFlatFallback` from the code and deploy the same three services. Update the current docs. The contract applies again. | No |

Phase order matters:

- docs-runtime deploys before the API. The API writes tree-only versions from
  phase 1, and the runtime must read them.
- Do not publish between phase 1 and phase 3 if a rollback is possible. A
  rollback to the old code cannot read versions that phase 1 wrote. Such a
  version must then be published again.

## Production Data

State on 2026-09-30 (read-only checks):

| Site | Versions | Live version | Pages | Manifest schema |
|---|---|---|---|---|
| `flagforge` | 15 | v11 | 50 | 2 |
| `aimemory` | 1 | v1 | 12 | 1 (no field) |
| `doxa-demo` | 0 | none | 0 | none |

- All 16 versions get a tree in phase 2. The history and the rollback targets
  stay.
- The three custom domains keep working. Hostname resolution does not change.
- Saved HTML stays valid, because the identities do not change.
- No branches exist in production, so no branch data changes.
- `aimemory` keeps its schema v1 manifest. Readers still support schema v1.

## Tests

| Area | Tests |
|---|---|
| `docs-engine` | Tree schema and validation. Writer: skips known blobs, writes the tree last, rejects unsafe paths. Adapter: logical reads and lists, missing tree, invalid tree, blob of another site, fallback on and off. |
| API | End-to-end publish on an in-memory R2: only changed blobs are written, and the result reads back through the logical store. Blob sweep: referenced blobs stay, young blobs stay, old unreferenced blobs go, an invalid tree stops the sweep. Migration: backfill is idempotent, verify finds a wrong hash, prune runs only after verify. |
| docs-runtime | The gate harness with trees gives the same golden output. A missing tree gives the same error as a missing manifest. |
| Generation Worker | Finalization writes a valid tree. Reusable pages read through the tree. |
| Benchmark | The simulated merge benchmark from 2026-09-28: 100 pages, 40 ms per R2 call. |

Checks before each deploy: `pnpm typecheck`, the tests of every changed
package, and the three compatibility suites.

## Production Rollout (2026-09-30)

| Phase | Result |
|---|---|
| 1 | Deployed docs-runtime `ee6d87bc`, API `a21f5e50`, generation Worker `2381fff0`. Search results matched the baseline byte for byte. |
| 2 | `backfill` converted 12 folders into 190 blobs. 4 folders had no files: branch previews 1 to 4 of `flagforge`, already collected by the preview collector, not live. |
| 3 | `verify` reported `ok` for the 12 folders. Fresh renders of both sites returned 200. |
| 4 | With owner approval, `prune-legacy` deleted 600 flat files. No folder has flat files. Fresh renders and search still matched. |
| 5 | The flat fallback was removed from the code, and the three Workers were deployed again. |

## Implementation Notes (2026-09-30)

Changes from the first draft of this plan:

- **Writer check after the commit.** A blob sweep can delete an old
  unreferenced blob while a writer uploads the same bytes again. After it
  writes the tree, the writer now checks each blob that it uploaded and uploads
  a missing blob again. The sweep lists blobs before trees, so a tree that it
  did not see can only reference a blob that its writer restores.
- **No sweep after the prune.** The prune deletes flat files only. It removes no
  tree, so no blob becomes unreferenced.
- **Logical store is read-only.** `DocsContentStore` lost `write`, `remove`,
  and `removeMany`. A new version is created only through `openVersion`. The
  garbage collector and the migration use the new physical `DocsObjectStore`.
- **Admin calls** need a trusted `Origin` header and a JSON body, at least
  `{}`. The runbook is in `docs/current/docs-content-storage.md`.

Benchmark after this change (simulated R2 latency of 40 ms per call):

| Action | Flat storage, before any fix | Flat storage, after cbdce34 | Version trees |
|---|---|---|---|
| Sync (POST), 100 pages | 8,508 ms | 219 ms | 90 ms |
| Merge, 100 pages | 9,945 ms (303 reads, 106 writes) | 1,693 ms (102 reads, 106 writes) | 891 ms (100 reads, 10 writes) |
| Merge, 500 pages | not measured | not measured | 3,023 ms (500 reads, 10 writes) |

The number of writes no longer depends on the site size.

### Decision: page reads in a merge (2026-09-30)

The user approved this rule: a merge reads only the changed pages. An
unchanged page keeps its manifest title, its navigation title, and its search
entry from the base version. Search entries must stay complete, so an
unchanged page without an entry is read to build one, and an unreadable base
index causes a full rebuild.

| Action | Version trees, all pages read | Version trees, changed pages only |
|---|---|---|
| Merge, 100 pages | 891 ms (100 reads, 10 writes) | 316 ms (4 reads, 10 writes) |
| Merge, 500 pages | 3,023 ms (500 reads, 10 writes) | 318 ms (4 reads, 10 writes) |

## Risks

| Risk | Mitigation |
|---|---|
| The sweep deletes a blob that a running publish needs. | One-hour age rule, the writer check after the commit, and writers copy entries only from trees that the collector keeps. |
| A tree is lost or corrupt. | Readers fail closed for that version. The sweep stops when one tree is invalid, so no blob is lost. |
| Prune runs before every tree is correct. | Prune checks each folder again with the `verify` rules. The user approves phase 4. |
| A cold request is slower. | One tree read per version and isolate. The tree is cached after that. |
| Worker subrequest limit during the migration. | Each call handles a bounded number of versions. |
