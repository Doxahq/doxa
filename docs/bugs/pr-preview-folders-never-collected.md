# PR Preview Folders Are Never Collected

**Status:** fixed on 2026-10-16 by the `docs_retired_version` collector. See [Storage Garbage Collection](../current/storage-garbage-collection.md#retired-versions). **Severity:** low (storage cost only). **Found:** 2026-09-25, in the review of the docs branching work.

## Fix

1. A preview is finished when a newer push replaced it (`preview_replaced_at`) more than `previewPromoteDays` (7 days by default, from the `RetentionPolicy`) ago.
2. After that, Promote refuses the run (`promote_expired`), and the contract exposes the reason.
3. The collector keeps every pointer rule of `findPreviewVersionRetention`. It drops the generation job rule only for a run that cannot promote any more, and it never uses the `docs_preview_version` collector for a pull request preview.
4. The replaced preview is queued with a one-hour grace period. The policy decides at inspect time.
5. The folder is shared with a promotion row, so the collector inspects every row of the folder and keeps it while production keeps the promotion. `tests/services/storage-gc-retired-version.test.ts` covers the promotion case.

## Summary

A source change preview (a pull request preview) writes a full artifact folder to R2 for every push. When a newer push replaces the preview, nothing deletes the old folder. The folders stay in R2 forever.

This is a storage leak. It does not break a site. Do not "fix" it by queueing the old folder for the `docs_preview_version` collector. That change caused a critical bug once, as the next section explains.

## Why the Simple Fix Is Wrong

The branching work first queued the replaced PR preview version for collection. That code could delete the files of the live production site:

1. A PR preview P1 is built. Its files are in `sites/{site}/versions/{P1}/`.
2. The user promotes the P1 generation. `promoteForProject` in `apps/api/src/repositories/jobs.ts` inserts a new production version V2. V2 has the same `artifact_prefix` as P1. No files are copied.
3. A new push replaces the preview. P1 is queued for collection.
4. The collector sees that no pointer uses P1, and it deletes P1's folder. Production V2 now has no files.

The same problem occurs if the promotion happens during the grace period, and for a history restore to V2.

The local database had three production versions that share a folder with another version on 2026-09-25, so this situation is normal, not rare.

The fix removed the enqueue from `apps/api/src/repositories/docs.ts`. The test `advances an existing preview for an updated head` in `apps/api/tests/services/preview-publication.test.ts` asserts that no `docs_preview_version` entry is queued; it now expects a `docs_retired_version` entry instead.

## Facts for the Fix

- Generation writes to `buildArtifactPrefix(siteId, versionId)`, so a PR preview folder is named by the preview version ID.
- A promotion and a rollback reuse the source folder. The folder then belongs to more than one version row.
- A generation job keeps `docs_version_id` after it succeeds, and the dashboard can promote it later. A deleted folder would make that promotion publish a broken site.
- A newer PR preview can use an older one as its incremental baseline. See `apps/api/src/repositories/preview-baselines.ts`. Generation state can also live under the version folder.
- Preview channels have a `lifecycle_state` of `active`, `closed`, or `expired`. A closed or merged pull request is the natural point to collect its folders.
- `DocsVersionGcRepository.findPreviewVersionRetention` in `apps/api/src/repositories/docs-version-gc.ts` already keeps a folder if another version row shares it, if the version is not a preview, or if a site, channel, branch, publication, baseline, or generation job points to it. A generation job always points to its version, so today this check keeps every PR preview folder.

## What a Correct Fix Must Do

1. Decide when a PR preview version is finished. For example: the pull request closed or merged, and its channel is not `active`.
2. Decide what happens to the generation job of a finished preview. Either the job can no longer promote, or promotion copies the files into a new folder instead of sharing one.
3. Keep every retention rule of `findPreviewVersionRetention`. Remove the generation job rule only for jobs that step 2 made unable to promote.
4. Queue the finished preview versions with a grace period that covers open tabs.
5. Test the promotion case end to end: build a preview, promote it, replace or close the preview, run the collector, then check that production still has its files.

## References

- Review finding #1 and its fix: `docs/current/storage-garbage-collection.md`, section "Documentation Version Prefixes".
- Collector: `apps/api/src/services/storage-gc/collectors/docs-version-prefix.ts`.
- Promotion: `promoteForProject` in `apps/api/src/repositories/jobs.ts`.
