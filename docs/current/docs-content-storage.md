# Docs Content Storage

**Status:** Implemented. Production was migrated on 2026-09-30 (see
[Migration](#migration)).
**Last reviewed:** 2026-10-23

This document describes how published docs versions are stored in the
`doxa-docs-artifacts-enam` R2 bucket. For the reason behind the design, see the plan
[Content-Addressed Docs Storage](../superpowers/plans/2026-09-30-content-addressed-docs-storage.md).

The bucket has the location hint `enam` (Eastern North America), near the API
Worker, which runs in `aws:us-east-1` next to the database. Until 2026-10-22,
production used `doxa-docs-artifacts` in Western Europe (`WEUR`), so every read
from the API crossed the Atlantic. That old bucket is no longer bound by any
production Worker. Local and preview configs still name it.

## Layout

```text
sites/{siteId}/versions/{versionId}/tree.json   one tree per version
sites/{siteId}/blobs/{sha256}                   one blob per unique file content
```

- A **blob** holds the exact bytes of one file. Its key is the SHA-256 hash of
  those bytes. A blob never changes.
- A **tree** maps each artifact path of one version to a blob. It is the only
  object in a version folder.
- Blobs belong to one site. Two sites never share a blob, so a reader never
  reads outside the resolved site.

Other prefixes do not change: site assets (`sites/{siteId}/assets/`),
generation state (`sites/{siteId}/generation-state/`), and generation
checkpoints (`_generation-checkpoints/`).

### Tree format

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

- Paths are sorted, so the same tree always has the same bytes.
- A path is relative and safe: no leading `/`, no `..`, no `.`, no `\`, no
  empty segment. `tree.json` is not a valid artifact path.
- A tree has at most 20,000 files.
- `formatVersion` is part of the compatibility contract. Readers must accept
  every format version in `SUPPORTED_VERSION_TREE_FORMAT_VERSIONS`.

## Logical Keys

Code outside the storage layer never builds a blob key. It uses the logical key
`{artifactPrefix}/{path}`, for example
`sites/{siteId}/versions/{versionId}/source/guide/index.mdx`.

- The reader resolves a logical key: it reads the tree of the folder, finds the
  entry, and reads the blob.
- `docs_versions.artifact_prefix` and `manifest_path` hold logical values. So
  hostname resolution, `artifactIdentity`, and the pre-render `renderId` do not
  depend on the storage layout.

## Reading

`createVersionTreeReader` in `packages/docs-engine/src/version-tree.ts` is the
only reader. Each app wraps it once:

| App | Entry point |
|---|---|
| API | `createR2DocsContentStore` and `createR2DocsArtifactReader` in `apps/api/src/services/docs-content/store.ts` |
| docs-runtime | `artifactReader` in `apps/docs-runtime/src/artifact-storage.ts` |
| Generation Worker | `artifactReader` in `apps/agent-worker/src/artifact-storage.ts` |

Rules:

1. A key outside a version folder goes to R2 unchanged.
2. A version without a tree does not exist. The read returns null. Readers
   never read an old flat file.
3. An invalid tree, or a tree of another folder, throws `VersionTreeError`. The
   reader fails closed.
4. A tree entry whose blob is missing throws `VersionTreeError` with the code
   `blob_missing`.
5. The reader keeps up to 128 parsed trees per bucket binding and isolate.
   Trees never change, so the memory cache has no expiry. A missing tree is
   never kept.

A cold request for a version costs one more R2 read for its tree.

### Caches of the Workers

The API and the docs runtime build their reader caches with
`workerVersionCaches` in `packages/docs-engine/src/version-edge-cache.ts`:

| Tier | Trees | Small blobs (256 KB or less) |
|---|---|---|
| Isolate memory | Parsed, 128 per binding | 8 MB LRU in the API. None in the docs runtime, which caches parsed results above the reader. |
| Workers Cache API of the data center (`caches.default`) | Raw bytes, 24 hours | Raw bytes, 1 year |

- A new isolate reads a tree or a blob that another isolate of the same data
  center read before, without an R2 call. The API reports an R2 tree read as
  `r2.tree` in `Server-Timing`, so a cached tree has no `r2.tree` step.
- The cache URL is `https://docs-version-cache.internal/{trees|blobs}/{key}`.
  It is never fetched.
- Only objects that R2 returned are kept, and a tree only after it parses.
  A damaged cached tree is a miss.
- A tree entry expires after 24 hours, so a deleted version stops resolving
  from the cache in the end. A reader resolves a version through its database
  row first, so it does not ask for a deleted version.
- A fill runs through `waitUntil`, so it can finish after the response.

## Writing

`VersionTreeWriter` is the only writer.

1. `put(path, content, contentType)` hashes the content. It uploads the blob
   only when no known tree already holds that hash.
2. `copy(path)` reuses an entry of the base tree without a read or a write.
3. `commit()` writes `tree.json` last. The version does not exist before this
   write.
4. After the commit, the writer checks each blob that it uploaded and uploads a
   missing blob again. This closes a race with the blob sweep.

The database row of a version is created after the commit, as before.

| Writer | Code |
|---|---|
| Branch publish and branch preview | `createMaterializer` in `apps/api/src/services/docs-branches/materialize.ts` |
| Branch image upload | `DocsBranchAssetUpload` in `apps/api/src/services/docs-branches/assets/asset-upload.ts` |
| Starter publication | `publishStarterDocs` in `apps/api/src/services/starter-docs.ts` |
| Container generation | `runContainerGeneration` in `apps/api/src/services/container-generation.ts` |
| Durable generation | `writeArtifactVersion` in `apps/agent-worker/src/artifact-storage.ts` |

A branch image upload (MCP `upload_asset`) is a writer too
(`DocsBranchAssetUpload` in `apps/api/src/services/docs-branches/assets/`). It
commits a version folder with one file, `assets/{name}`, and no database
version row. The branch change at `assets/{name}` holds a pointer to that
folder, not the image. A publish or a preview build copies the folder's tree
entry with `copyFrom`, so it reads and writes no image byte. The folder's tree
keeps the blob safe from the sweep until a published or preview tree marks it
too. The `docs_branch_asset_folder` collector removes the folder when no
change row of any branch of the site points to it (a branch created from
another branch copies its image rows); see
[Storage Garbage Collection](storage-garbage-collection.md).

A branch publish passes its base tree to the writer. Unchanged files are
copied, so a publish writes only the changed pages, the rebuilt manifest,
settings, navigation, search files, and the tree.

A branch publish reads only the pages that the branch changed:

- A changed page gets its title from its front matter and a rebuilt search
  entry.
- An unchanged page keeps its title and its search entry from the base
  version. It is not read.
- An unchanged page without a search entry is read, and it gets a new entry.
- When the base search index is missing or unreadable, every page is read and
  the full index is rebuilt.

## Garbage Collection

See [Storage Garbage Collection](storage-garbage-collection.md).

- The version folder collectors delete the physical keys of a folder: its
  `tree.json` and, during the migration, its old flat files. After a complete
  deletion, they enqueue a `docs_site_blobs` entry for the site.
- The `docs_site_blobs` collector is a mark-and-sweep for one site. Every tree
  of the site marks its blobs. A blob that no tree marks, and that is older than
  one hour, is deleted. One invalid tree stops the sweep before any deletion.

Invariant: a writer copies entries only from a tree that the collectors keep.
The base of a publish is a production version or a branch base, and no
collector deletes those trees. The upload folder of a branch image stays while
a change row points to it.

## Migration

Production was migrated on 2026-09-30:

- 12 of 16 version folders were converted and verified. They share 190 blobs.
- 600 old flat files were pruned.
- 4 folders had no files before the migration: branch previews that the
  preview collector had already deleted. None of them was live.
- After the migration, the readers lost their flat fallback.

The migration used four admin routes of the API: `inventory`, `backfill`,
`verify`, and `prune-legacy`. The admin routes were removed on 2026-10-23,
together with their migration service. The plan
[Content-Addressed Docs Storage](../superpowers/plans/2026-09-30-content-addressed-docs-storage.md)
records how the routes worked.

A local development bucket can still hold flat folders. A reader cannot see
them, and no tool converts them now. To render such a local site, generate its
docs again. The new version gets a tree.

### Rollback

- The last step of the migration pruned the old flat files in production.
  The Worker versions from before the migration cannot read the sites, because
  the flat files are gone. Do not roll back to them.
- A rollback to a Worker version from phase 1 or later is safe. Those versions
  read the trees.

## Main Files

- `packages/docs-engine/src/version-tree.ts`
- `packages/docs-engine/src/version-edge-cache.ts`
- `apps/api/src/services/docs-content/store.ts`
- `apps/api/src/services/docs-branches/materialize.ts`
- `apps/api/src/services/storage-gc/collectors/docs-site-blobs.ts`
- `apps/docs-runtime/src/artifact-storage.ts`
- `apps/agent-worker/src/artifact-storage.ts`
