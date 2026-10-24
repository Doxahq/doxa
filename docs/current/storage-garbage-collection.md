# Storage Garbage Collection

## Purpose

Doxa writes derived objects to storage. A published version, a cache artifact, or a rendered page can stop serving production at any time.

This subsystem deletes those objects. One work list, one scheduled runner, and one collector for each kind of resource.

A feature that writes derived objects does not need its own scheduler, retry policy, or deletion loop.

## Model

A collector owns the deletion policy for one kind of resource. It has one target name, for example `docs_prerender_render`.

The work list is the `storage_gc_entries` table. One row is one resource that stopped serving production.

A row stores a typed resource, never a storage key. The collector maps the resource to its keys. A caller cannot ask for a key or a prefix.

The runner claims due rows, asks the collector to inspect each resource once more, and deletes the objects only when the collector agrees.

## Life of an Entry

1. A feature calls `enqueueStorageCollection` when a resource stops serving production. The call accepts a transaction.
2. The entry waits for its grace period. The `eligible_at` column holds that time.
3. The scheduled runner claims the entry with a lease and a claim token.
4. The collector parses the resource. An invalid resource fails the entry.
5. The collector inspects the resource against live data. A resource that still serves production becomes `retained`.
6. The collector deletes the objects. A large resource reports `incomplete` and returns to the work list.
7. The entry becomes `collected`.
8. The runner deletes finished entries that are older than `STORAGE_GC_LIMITS.historyDays`.

A failed entry retries with a delay. The entry stops after `STORAGE_GC_LIMITS.maxAttempts` attempts and stays visible in the health report.

An entry whose target has no collector in this deployment returns to the work list with a one-hour delay. It consumes no attempt, so a later deployment can still collect it.

## Safety Rules

The inspect step is mandatory. Enqueue records an intent. Only the collector decides that deletion is correct.

A grace period covers stale readers. The dispatcher can hold a resolved hostname for one hour, so pre-rendered output waits 24 hours.

Deletion runs in the Worker that owns the write binding for that storage. The API drives policy and never holds a delete binding it does not need.

An entry that reopens is idempotent. A repeated enqueue for an open entry keeps the existing schedule. A finished entry restarts, because the same resource can be written again.

## Adding a Collector

Site assets live at `sites/<siteId>/assets/<sha256>`, outside version prefixes.
An asset remains live while a retained version or a branch site-settings change
references its hash. A future asset collector must inspect both sources before
deletion. Unreadable site settings retain assets until inspection succeeds.
Deleting an obsolete version never deletes the site asset prefix. This change
adds no asset collection job or schedule.

1. Add the resource schema and the target name to `packages/contracts/src/storage-gc.ts`.
2. Implement `StorageCollector` with `parse`, `inspect`, and `collect`.
3. Register the collector in `createStorageCollectors` in `apps/api/src/services/storage-gc/index.ts`.
4. Call `enqueueStorageCollection` where the resource stops serving production.
5. Add deterministic tests for the inspect decision and for the key range of the delete call.

No migration is necessary. The `target` column is text, and the resource column is JSON.

## Pre-rendered Documentation

The `docs_prerender_render` collector deletes the manifest and the content objects of one render.

An entry is created when a pre-render task becomes obsolete. A task becomes obsolete when the published version changes, when the hostname stops serving the site, or when the renderer release changes.

The inspect step recomputes the render identity for every active production hostname of the site. It keeps the render when any hostname still resolves to it.

The delete call reaches the pre-render Worker through the `PrerenderQueue` service binding. The Worker builds the object prefix from the validated site and render identity.

A rollback republishes a retired identity. The task row revives, and the inspect step reports the render as current, so the objects stay.

## Documentation Version Prefixes

A version folder holds one `tree.json`. Its files are content-addressed blobs under `sites/<siteId>/blobs/`, which several versions can share. See [Docs Content Storage](docs-content-storage.md).

The `docs_preview_version` collector deletes the artifact prefix of a branch preview. It never runs for a source change (PR) preview. A promotion serves the files of its source preview, so a replaced source change preview can still hold production files. The `docs_retired_version` collector (see [Retired Versions](#retired-versions)) collects those folders with the promotion check. It fixes the bug [PR preview folders are never collected](../bugs/pr-preview-folders-never-collected.md).

The collector checks every rule below before it deletes a prefix. Each rule keeps the prefix:

| Rule | Result |
|---|---|
| Another version row uses the same `artifact_prefix`. A promotion or a rollback does this. | Retained. The prefix belongs to that row. |
| The version row is not on the `preview` channel. | Retained. Production prefixes are never collected here. |
| A site head, a preview channel, a branch base, a publication, a version baseline, or a generation job points to the version. | Retained, and checked again after six hours. |

Branch previews have two grace periods:

- A replaced preview waits one hour, for renders that started before the channel moved.
- The preview of an erased branch waits zero seconds. Erase, publish with erase, and discard of the hidden branch delete the branch and its channel in one transaction. After the commit, the API collects the entry at once with `StorageGarbageCollector.collectNow`. If that call fails, the scheduled run collects the entry.

Preview hostnames never enter the dispatcher hostname cache, because the cache stores only public production resolutions. When the channel row is gone, the hostname stops resolving at once.

The `docs_orphan_version_prefix` collector deletes a prefix when materialization did not create a version row for it. The API enqueues the entry before it writes the immutable artifacts. The entry waits 24 hours. If a version row uses the prefix, by ID or by `artifact_prefix`, the collector keeps it.

Branch preview builds write the artifacts before the database transaction starts. The transaction only locks the site and the branch to move the channel. Preview versions and production versions count in separate sequences per site (migration `0025`), so a preview never takes a published number.

Both collectors accept only a validated `{ siteId, versionId }` resource. They build the prefix with `buildArtifactPrefix` and never accept a storage key.

Both collectors delete the physical keys of the folder: its `tree.json` and, until the storage migration ends, its old flat files. They never delete a blob. After a complete deletion, they enqueue a `docs_site_blobs` entry for the site.

## Branch Image Folders

An image upload (MCP `upload_asset`) writes a version folder with one file,
`assets/{name}`, and a branch change that points to it. The upload enqueues a
`docs_branch_asset_folder` entry before it writes the folder. The resource is
`{ siteId, versionId, branchId }`, and the grace period is one hour.

| Rule | Result |
|---|---|
| A version row uses the folder | Retained. |
| A change row of any branch of the site points to the folder (a branch created from the uploading branch copies its image rows) | Retained, and checked again after six hours. |
| No change row points to it: every such branch was published, deleted, or erased, or the rows were replaced | Collected. |

The collector deletes the folder's `tree.json` and enqueues `docs_site_blobs`.
A published or preview version that copied the image still marks its blob.

## Documentation Site Blobs

The `docs_site_blobs` collector is a mark-and-sweep for the blobs of one site. Its resource is `{ siteId }`. The entry has no grace period.

1. It lists the blobs of the site.
2. It reads every `tree.json` in the version folders of the site. Each tree marks its blobs.
3. It deletes a blob that no tree marks and that is older than one hour.

Rules:

| Case | Result |
|---|---|
| One tree is invalid | The entry fails before any deletion. An unreadable tree can reference any blob. |
| An unmarked blob is younger than one hour | The blob stays. A running publish can own it. The entry returns after one hour. |
| More than `objectsPerEntry` blobs to delete | The entry deletes one batch and returns to the work list. |

A publish writes its blobs before its tree. After its commit, the writer checks each blob that it uploaded and uploads a missing blob again. A sweep that listed the blobs before the commit can therefore not leave a tree with a missing blob.

A repeated enqueue for an open entry keeps its schedule. A sweep that is already running can miss a folder that was deleted at the same moment. The blobs of that folder stay until the next sweep of the site.

A collector can return `retain` with `recheckAfterSeconds`. The runner then puts the entry back on the work list, and it does not mark the entry as `retained`.

## Deleted Projects

`DELETE /projects/:projectId` deletes a project permanently. The steps run in this order:

1. The API refuses the request while a generation is queued or running. The container of that generation still writes files.
2. The API deletes the Cloudflare custom hostnames of the project. If Cloudflare fails, the project stays and the user can try again.
3. One transaction locks the project row, deletes the project, and the foreign key cascade deletes the site, versions, branches, domains, jobs, and pre-render tasks. The same transaction queues:
   - a cache purge for the site and for each of its hostnames,
   - a `docs_prerender_render` entry for each render of the site,
   - one `docs_deleted_site` entry for the site.

A job insert takes a key share lock on the project row, so no generation can start between the check and the delete.

The `docs_deleted_site` collector has the resource `{ siteId }` and a grace period of one hour, for dispatchers that still hold a resolved hostname. Its inspect step keeps the storage while a site row with this id exists. Its collect step deletes every key under `sites/<siteId>/` except blobs: version folders, generation state, and site assets. A large site returns to the work list in batches. After a complete deletion, it enqueues a `docs_site_blobs` entry. No tree of the site remains, so the sweep deletes every blob that is older than one hour.

The `docs_prerender_render` entries need no new rule. With the site row gone, no hostname resolves to a render, so the collector deletes it after its usual 24-hour grace period.

An example project that fails its first publish uses the same deletion, so the example files that were already written are collected too.

## Retention Policy

`RetentionPolicy` (`packages/contracts/src/retention-policy.ts`) holds every retention value of a project:

| Field | Default | Meaning |
|---|---|---|
| `productionHistory.keepLatest` | 20 | The newest published production versions stay restorable. |
| `productionHistory.keepDays` | 90 | A production version stays restorable for this many days after its last publication. |
| `previewPromoteDays` | 7 | A replaced pull request preview stays promotable for this many days. |

A production version stays restorable while either history rule keeps it. `resolveRetentionPolicy(project)` in `apps/api/src/services/retention-policy.ts` is the only reader of `DEFAULT_RETENTION_POLICY`. It returns the default today, and it will merge plan overrides (`RetentionPolicyOverrides`, every field optional) later. The collectors and the Promote rule call the resolver when they decide, never at enqueue time. A plan change therefore needs no data migration: the next inspection applies it.

## Retired Versions

The `docs_retired_version` collector deletes the folder of a version that stopped serving. Its resource is `{ siteId, versionId }`, and the grace period is one hour. These events queue an entry in the transaction that moves the pointer:

| Event | Code | Version queued |
|---|---|---|
| A publication, promotion, restore, or generation moves the site to another version | `recordPublication` | The previous production version |
| A newer push moves a pull request preview channel | `completeJob` (`retireReplacedPreview`) | The replaced preview. Its `preview_replaced_at` is set. |
| A person discards a generation review | `GenerationReviewsRepository.discard` | The staged version of the review |
| A person deletes a generation | `JobsRepository.deleteForProject` | The version of the generation |

Each event also queues a `docs_generation_state` entry for the state that the version names. The checkpoints of a deleted generation (`_generation-checkpoints/<jobId>/`) are not queued: the R2 lifecycle rule of that prefix owns them. Migration `0039` queues every production version that is not live and every replaced generation preview once.

The inspect step locks the site row. It reads every version row that shares the folder: the row itself and every row whose `artifact_prefix` names the same folder (a promotion stores the prefix of its source preview). A row keeps the folder when one of these rules keeps it:

| Rule | Result |
|---|---|
| The site serves it, a preview channel serves it, a branch builds on it, an open review stages it, or a queued or running generation reads or writes it | Retained, checked again after six hours. |
| It is a published production version that the history rules keep | Retained, checked again after one day. |
| It is a pull request preview with a succeeded generation, and it was replaced less than `previewPromoteDays` ago | Retained, checked again after one day. |

A row whose `artifacts_collected_at` is set keeps only its pointers. When no row keeps the folder, the same transaction sets `artifacts_collected_at` on every row of the folder and queues their generation states. The collect step then deletes the folder's `tree.json` and queues `docs_site_blobs`. It reads the folder from the stored prefix and builds the key with `buildArtifactPrefix`.

A collected row stays in the history. The publications list shows it as **No longer restorable** (`noLongerRestorable`), and a restore refuses it. Promote refuses a collected version (`version_collected`) and a preview replaced longer ago than the policy allows (`promote_expired`). Restore and Promote lock the site row, so they wait for an inspection that marks the version, and then refuse it.

A promoted preview's folder belongs to production: the promotion row shares it, so it stays while production keeps the promotion.

## Generation State

The `docs_generation_state` collector deletes `sites/<siteId>/generation-state/<versionId>/`. Several versions can name one state: an edited version inherits the state of its base, a reviewed version names the state of the staged run, and a promotion copies the state of its preview.

The inspect step reads every version row whose `generation_state_prefix` names the state. It keeps the state while any of them can be a baseline, with the same rules as [Retired Versions](#retired-versions): the published version, a version in the rollback window, the staged version of an open review, a current or promotable preview, a branch base, or the baseline, seed, or output of a running generation. Generation state holds no blobs.

## R2 Lifecycle Rules

Two systems delete derived storage, and every prefix has exactly one owner:

- A storage GC collector owns data that a row can point to: everything under `sites/`.
- An R2 lifecycle rule owns data that nothing points to and that is safe to lose: scratch files and caches.

A rule names one dedicated prefix, never the bucket root, because the docs artifacts share the `doxa-docs-artifacts-enam` bucket. The rules are defined in `packages/contracts/src/storage-lifecycle.ts` (`R2_LIFECYCLE_RULES`). A test checks that this section lists the install command of every rule.

| Rule id | Prefix | Expires after | Why |
|---|---|---|---|
| `doxa-generation-checkpoints-expiry` | `_generation-checkpoints/` | 30 days | The last Workflow step deletes the checkpoints of a successful run. A failed or cancelled run leaves them. |
| `doxa-generation-diagnostics-expiry` | `_generation-diagnostics/` | 30 days | Failed MDX drafts. Their `generation_repair_diagnostics` rows also expire after 30 days. |
| `doxa-page-cache-expiry` | `cache/pages/` | 30 days | Written-page cache. Installed on 2026-07-30. |
| `doxa-plan-cache-expiry` | `cache/plans/` | 30 days | Generation plan cache. |

R2 counts the age of an object from its upload. A page cache read rewrites an entry that is older than `R2_CACHE_REFRESH_AFTER_DAYS` (20 days), so an entry that lookups still hit never expires.

Doxa never applies the rules. To install them, run these commands once (`doxa-page-cache-expiry` exists already; skip it unless `list` does not show it):

```bash
npx wrangler r2 bucket lifecycle add doxa-docs-artifacts-enam doxa-generation-checkpoints-expiry _generation-checkpoints/ --expire-days 30 --force
npx wrangler r2 bucket lifecycle add doxa-docs-artifacts-enam doxa-generation-diagnostics-expiry _generation-diagnostics/ --expire-days 30 --force
npx wrangler r2 bucket lifecycle add doxa-docs-artifacts-enam doxa-page-cache-expiry cache/pages/ --expire-days 30 --force
npx wrangler r2 bucket lifecycle add doxa-docs-artifacts-enam doxa-plan-cache-expiry cache/plans/ --expire-days 30 --force
```

An older runbook installed `generation-diagnostics-7d` on `_generation-diagnostics/`. If `list` shows it, remove it, so the prefix has one rule:

```bash
npx wrangler r2 bucket lifecycle list doxa-docs-artifacts-enam
npx wrangler r2 bucket lifecycle remove doxa-docs-artifacts-enam --id generation-diagnostics-7d
```

Keep the bucket-wide multipart-abort rule. It deletes no stored object.

## Workflow Instance State

Cloudflare keeps the state of a finished generation Workflow instance for `GENERATION_WORKFLOW_RETENTION`: 7 days after a success or a termination (cancel), 30 days after an error. The agent worker passes this as `retention` to `GENERATION_WORKFLOW.create()`.

Wrangler can set the same values as `default_retention` on the `workflows` binding (`success_retention`, `error_retention`). The Wrangler version of this repo (4.100.0) drops that field with an "Unexpected fields" warning, so the setting lives in code.

## Database Rows

| Rows | Retention |
|---|---|
| `generation_usage_records` | Kept. Billing decides their retention later. Migration `0038` made `expires_at` nullable and cleared it. |
| `generation_repair_diagnostics` | 30 days. The agent-worker cron deletes expired rows in batches. |
| `generation_jobs`, `job_events` | Kept. A deleted generation removes its own rows. |

## Operations

The runner reports one structured event for each scheduled run:

```text
event = "storage_gc_health"
```

Create an alert for this filter:

```text
event = "storage_gc_health" AND status = "degraded"
```

Also alert on these event values:

- `storage_gc_entry_failed`
- `storage_gc_target_unknown`

Read the current work with this query:

```sql
select target, status, count(*), max(attempt_count)
from storage_gc_entries
group by target, status;
```

To stop collection for one target, remove its collector from the registry and deploy. The entries stay in the work list.
