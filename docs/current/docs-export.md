# Docs Export

**Status:** Implemented 2026-11-16. Not deployed.

A user can download the published docs of a project as one `.zip` file. The
file holds every page, image and setting, so the user can self-host Doxa or
keep a copy. The home page promises this ("One-click export").

## Flow

1. The Export docs card in Project settings calls
   `GET /projects/:projectId/export/status`.
2. If the export can run, the card opens `GET /projects/:projectId/export`
   as a plain link. The browser saves the `attachment` response itself, so
   the page never holds the archive in memory.
3. The API on ECS reads the published version tree and streams the zip. It
   writes nothing to R2 and leaves no file to clean up.

In local dev, the dashboard signs in with the `x-doxa-user-id` header. A link
cannot send that header, so there the card fetches the archive instead.

## Archive layout

| Path | Source |
|---|---|
| `export.json` | Format `doxa-docs-export`, version 1, project, version, and the path, sha256 and size of every file |
| `doxa.json` | `settings/site.json`, the site configuration |
| `settings/` | The other settings files: navigation and features |
| `pages/<slug>.mdx` | `source/<slug>/index.mdx`. `source/index.mdx` becomes `pages/index.mdx`. |
| `assets/` | Page images |
| `site-assets/<sha256>.<ext>` | Logo, favicon and social image that `doxa.json` names (`asset:<sha256>`) |
| `other/` | Any other artifact file under its artifact path, and any path that clashes |

The export leaves out `manifest.json` and `search/*`. Doxa builds them again
from the pages. Each entry has the publish time of the version as its date, so
the same version gives the same files.

## Limits

| Limit | Value | Where |
|---|---|---|
| Exports, Free account | 1 every 24 hours | `docs.export_window_hours` = 24 in `packages/billing/src/catalog/doxa.ts` |
| Exports, paid account (Pro, trial, Enterprise) | 1 every hour | `docs.export_window_hours` = 1 |
| Exports, past-due account after its grace period | 1 every 24 hours | `subscriptions.pastDueLimits` in the catalog |
| Exports, self-hosted plan | No quota | `docs.export_window_hours` = 0 |
| Open exports for each project | 1 on each API process | `MAX_OPEN_EXPORTS_PER_PROJECT` in `apps/api/src/routes/docs-export.ts` |
| Open exports on each API process | 3 | `MAX_OPEN_EXPORTS_PER_PROCESS` |
| Time for one export | 30 minutes | `EXPORT_MAX_DURATION_MS` |
| Time with no read from the client | 60 seconds | `EXPORT_IDLE_TIMEOUT_MS` |
| Size of one archive | 1 GiB, 30,000 files | `EXPORT_MAX_BYTES`, `EXPORT_MAX_FILES` in `services/docs-export/entries.ts` |
| Requests for each IP | 1,200 each minute | `API_PUBLIC_LIMITER` on the edge Worker |

The quota belongs to the billing account of the project, so a team project
counts against the team account. Two projects of one account share one
export each window.

The window is rolling. The next export opens one window after the last
export: a Free export at 23:59 UTC opens the next one at 23:59 UTC on the
next day. The table `billing_export_claims` (migration 0049) holds one row
for each account, with `last_export_at` and `previous_export_at`.

The window comes from the plan at the time of the check:

- An upgrade from Free to Pro, 3 hours after an export: the next export
  opens now.
- A downgrade from Pro to Free, 30 minutes after an export: the next export
  opens 24 hours after that export.

## Quota rules

- The route claims the export before the first byte, with one conditional
  upsert (`BillingStore.claimExport`): `INSERT ... ON CONFLICT DO UPDATE ...
  WHERE last_export_at IS NULL OR last_export_at <= now - window`. Two
  parallel requests can never both pass, also on two API processes. A denied
  claim writes nothing, so it does not move the window.
- If the export fails on the server side (a storage read, or a file that
  does not match its tree) before 10% of the archive is sent, the route
  gives the export back (`releaseExport`). The row goes back to
  `previous_export_at`, but only if `last_export_at` is still the time of
  this claim. A later failure counts.
- If the client cancels, the export counts. Otherwise a loop of canceled
  downloads could read the site without limit.
- A project without a published version (404 `no_published_version`) and a
  site above the size cap (413 `export_too_large`) do not count.
- With `BILLING_ENFORCEMENT=off` there is no quota and no billing read. With
  `shadow`, the route claims and logs a denial (`billing.denial`), then
  allows the export.
- If the billing read fails, the route answers 503 `export_unavailable`. A
  broken quota never means unlimited exports.

## Security

- Access: `withProjectAccess` with `docs.write`, so editors and up. An export
  spends the quota of the account, so a viewer cannot use the export of the
  owner. A user without access gets 404.
- The site, version and artifact prefix come from the database row of the
  published version (`getPublishedVersionForUser`). The client sends no ID,
  prefix or key.
- Every read goes through the version tree reader of that prefix, or to
  `sites/{siteId}/assets/{sha256}` of the same site. Asset hashes must match
  `asset:[a-f0-9]{64}`.
- The stream checks the size and the sha256 of every file against its tree
  entry. A mismatch stops the export.
- A GET passes the CSRF check, and a top-level link carries the session
  cookie. The route refuses `sec-fetch-site: cross-site` with 403, so another
  site cannot spend the quota of a user.
- The file name holds only `[a-z0-9-]`, so it cannot change the
  `content-disposition` header. Archive paths come from safe tree paths.
- The route refuses `HEAD` with 405. Hono runs the GET handler for a `HEAD`
  and drops the body without a cancel, so a `HEAD` would spend the quota and
  hold the slots.
- A client that reads nothing for 60 seconds loses its export, so a slow
  reader cannot hold the slots.
- The dashboard opens the route as a link. When a browser navigation
  (`sec-fetch-mode: navigate`) fails, the route answers 303 to
  `{WEB_ORIGIN}/dashboard/projects/:projectId/settings?export_error=<code>`.
  The target comes only from `WEB_ORIGIN`, never from the request. The card
  maps only known codes to a message.
- Deflate is synchronous, so the stream compresses a file in 256 KB pieces
  and yields to the event loop between them.
- The response is `no-store, private`.
- The export reads without the blob cache of the process, so a large export
  does not push dashboard pages out of that cache.

## Errors

| Status | Code | When |
|---|---|---|
| 403 | `cross_site` | `sec-fetch-site: cross-site` |
| 405 | `method_not_allowed` | A `HEAD` request |
| 404 | `no_published_version` | The project has no published version |
| 413 | `export_too_large` | Above 1 GiB or 30,000 files |
| 429 | `export_in_progress` | An export of this project, or 3 exports, already run on this process. `retry-after: 30`. |
| 429 | `export_limit` | The window after the last export is not over. The details hold `plan`, `windowHours` and `resetsAt`, the time when the next export opens. |
| 503 | `export_unavailable` | The billing read failed |

For a browser navigation, the 404, 413, 429 and 503 answers are a 303 to the
settings page with the code in `export_error`.

## Past-due accounts

A past-due account keeps the window of its plan for the grace period (7
days). After the grace period, it gets the Free window of 24 hours. The
other non-AI limits of its plan stay. An override of
`docs.export_window_hours` still wins.

## Main files

- `packages/billing/src/quotas/export-quota.ts`
- `packages/billing/src/store/postgres.ts` (`claimExport`, `readLastExport`, `releaseExport`)
- `packages/db/migrations/0049_billing_export_claims.sql`
- `apps/api/src/services/billing/export-billing.ts`
- `apps/api/src/services/docs-export/` (entries, service, zip stream)
- `apps/api/src/routes/docs-export.ts`
- `packages/contracts/src/docs-export.ts`
- `apps/web/src/components/dashboard/project-export-card.tsx`
