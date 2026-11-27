# Docs Content Storage

**Status:** Implemented. Production was migrated on 2026-09-30 (see
[Migration](#migration)).
**Last reviewed:** 2026-10-29

This document describes how published docs versions are stored in the
`doxa-docs-artifacts-enam` R2 bucket. For the reason behind the design, see the plan
Content-Addressed Docs Storage (`docs/superpowers/plans/2026-09-30-content-addressed-docs-storage.md` in the private ops repo).

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
| docs-runtime | `artifactReader` in `apps/docs-runtime/src/artifact-storage.ts`, one per request |
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

### Tiered Blob Cache of the Docs Runtime

`caches.default` is local to one data center. A cold read from a data center
far from the `enam` bucket still pays the full R2 round trip: 30–200 ms from
Europe and 340–841 ms from Singapore. The docs runtime can put a tiered Workers
Cache between `caches.default` and R2:

| Order | Tier | Holds | Cost |
|---|---|---|---|
| 1 | Isolate memory | Parsed trees | Free |
| 2 | `caches.default` of the data center | Trees (24 hours), blobs of 256 KB or less (1 year) | Free, local |
| 3 | `DocsBlobCache` (Workers Cache, lower and regional upper tier) | Trees (24 hours), all blobs (1 year) | One Workers request per read |
| 4 | R2 | Everything | One R2 read |

- `DocsBlobCache` is a named entrypoint of the docs runtime
  (`apps/docs-runtime/src/blob-cache.ts`). `wrangler.json` turns the Workers
  Cache on for it only (`exports`). The default entrypoint stays uncached.
  `RuntimeSourceApi` has RPC methods only, so it is not listed: Cloudflare
  rejects cache options for it, and it inherits the disabled Worker cache. `cache.cross_version_cache` is `true`, so a
  deploy keeps the entries: their bytes depend only on the key.
- The reader calls it with `ctx.exports.DocsBlobCache.fetch()`. Each request
  builds its reader with the binding of its own `ctx`, in the fetch handler
  and in each `RuntimeSourceApi` call. Only `fetch` calls are cached.
- The storage adapter (`createVersionObjectStorage` in
  `packages/docs-engine/src/version-object-cache.ts`) sends only the blob and
  tree keys that the tree layer builds (`parseImmutableStorageKey`). Every
  other key goes to R2 unchanged. If the entrypoint fails, the read goes to R2.
- The endpoint (`respondWithVersionObject`) accepts only a GET for
  `https://docs-object-cache.internal/{key}` with such a key, and nothing
  else (400, `no-store`). A missing object is a 404 with `no-store`, so a
  publish can write it a moment later. A blob must hash to its key and a tree
  must parse as the tree of its folder; otherwise the response is a 502 with
  `no-store`, and damaged bytes are never cached.
- The key holds the site id, so two sites never share an entry. No public
  route reaches the entrypoint, and its keys come only from resolved version
  folders and their trees.
- Entries carry the `Cache-Tag` values `docs-objects-site:{siteId}` and, for a
  tree, `docs-objects-version:{siteId}/{versionId}`. Only code in the
  `DocsBlobCache` entrypoint can purge them. No purge runs today; see below.
- `caches.default` stays in front. It is local and free, while each
  `DocsBlobCache` call is billed as a Workers request. A tier-2 hit makes no
  call; a tier-3 hit fills tier 2 as before.

#### Trees and Deleted Versions

Trees go through `DocsBlobCache` too, because the tree read is the first of
the two serial read levels of a cold page. A collected version can keep its
tree in the cache for up to one day after the last fill. This is safe:

- A version id is never reused, so a cached tree never names the wrong files.
- The reader asks for a tree only through a version that the database
  resolved. The collectors delete a folder only when no row serves it, and
  only after the 25-hour hostname grace period.
- The dispatcher caches rendered HTML of a version for a year under the same
  rule. Deleting the site row and purging the hostname mapping makes both
  unreachable.

A collected blob can stay in the cache for up to a year, but only a live tree
can name it, and its bytes are the same. If a cached object must ever leave
before it expires, add a purge method to `DocsBlobCache` that calls
`ctx.cache.purge({ tags })` with the tags above, and call it from the
collector.

#### Rollout and Logs

| Variable | Values | Default |
|---|---|---|
| `DOXA_PROD_BLOB_CACHE_MODE` | `off`, `allowlist`, `all`. Any other value is `off` and logs `docs_runtime_blob_cache_invalid_mode` once per isolate. | `off` |
| `DOXA_PROD_BLOB_CACHE_SITE_IDS` | Comma-separated site ids for `allowlist`. | empty |

`pnpm validate:production-config` checks the cache settings and the mode
(`scripts/deploy/lib/docs-runtime-config.mjs`).

The `docs_runtime_reads` log line has three counters for the storage reads
below the logical reads, by where they were served: `edgeCacheHits`
(`caches.default`), `blobCacheHits` (a `cf-cache-status` of `HIT`, `STALE`,
`UPDATING`, or `REVALIDATED`), and `r2Reads` (every read that reached R2,
directly or as the fill of a tiered-cache miss).

To turn the tiered cache off, set `DOXA_PROD_BLOB_CACHE_MODE` to `off` and
deploy the docs runtime. To remove it, also set
`exports.DocsBlobCache.cache.enabled` to `false`. Old entries do no harm:
their bytes cannot change.

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
Content-Addressed Docs Storage (`docs/superpowers/plans/2026-09-30-content-addressed-docs-storage.md` in the private ops repo)
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
- `packages/docs-engine/src/version-object-cache.ts`
- `apps/api/src/services/docs-content/store.ts`
- `apps/api/src/services/docs-branches/materialize.ts`
- `apps/api/src/services/storage-gc/collectors/docs-site-blobs.ts`
- `apps/docs-runtime/src/artifact-storage.ts`
- `apps/docs-runtime/src/blob-cache.ts`
- `apps/agent-worker/src/artifact-storage.ts`
