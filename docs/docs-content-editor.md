# Docs Content Editor

The dashboard content editor reads and changes the source of published
documentation. A project owner can edit `main` or a named branch.

## Model

A published documentation version is immutable. Its artifacts use one R2
prefix:

```txt
sites/<siteId>/versions/<versionId>/
  manifest.json
  source/<page>/index.mdx
  settings/documents*.json
  settings/sections.json
  settings/site.json
  search/index.json
```

The editor does not change this prefix. Working changes use these Postgres
tables:

- `docs_branches` stores the branch base, revision, and preview revision.
- `docs_branch_changes` stores one current change for each artifact path.
- `docs_publications` records each move of `main`.

A branch is a base version plus its working changes. The effective tree applies
the changes to that base version.

A named branch is visible in the dashboard. A user can create it from `main`
or another named branch.

The `main` editor uses a hidden branch. The service creates this branch on the
first edit. The dashboard continues to show the branch as `main`.

Working changes can contain page sources, the site structure, and site
settings. Search artifacts are rebuilt during publication.

## Edits

Every content request names a branch reference. The value is `main` or a named
branch UUID.

An edit request contains an ordered list of operations. The service applies the
whole list to one branch revision.

An edit that restores the base content removes its working-change row. The
branch therefore stores only real differences from its base.

Each page source has a 512 KiB limit. A branch can hold 2,000 changed paths and
32 MiB of changed content.

The database locks the branch row before it writes changes. This lock orders an
edit against publication, synchronization, and discard.

## Publication

A branch must use the current version of `main` as its base. The client also
sends the branch revision that the user reviewed.

Publication uses these steps:

1. Resolve the branch through the project owner.
2. Read the working changes and make sure that the branch is current.
3. Add a garbage-collection entry for the new version prefix.
4. Materialize the effective tree into a new immutable R2 prefix.
5. Lock the site row, then lock the branch row.
6. Make sure that the main version, branch base, and branch revision did not change.
7. Insert the production version and move `docs_sites.published_version_id`.
8. Record the publication in the same transaction.
9. Enqueue cache invalidation and pre-render work in that transaction.
10. Erase or reset the branch.

The hidden branch is always erased. A named branch is erased when
`eraseBranch` is true. Otherwise, it moves to the new base with no working
changes.

The materializer updates the manifest and navigation artifacts. It also rebuilds
the search index from the effective page sources.

### Publish progress

A publish request with `accept: text/event-stream` gets server-sent events.
A request without this header gets the plain JSON result, as before.

The events use `publishDocsBranchEventSchema` from
`@doxahq/contracts/docs-branches`:

| Event | When |
| --- | --- |
| `stage` `preparing` | The request starts: branch lookup and checks, steps 1 to 3. |
| `stage` `building` | The materializer writes the new version, step 4. |
| `stage` `optimizing` | The transaction, cache purge, and pre-render dispatch run, steps 5 to 10. |
| `result` | The new version is live. The data is the JSON result. |
| `error` | The publish failed. The data has the HTTP status and the JSON body of the plain request. |

The publish runs to its end if the client disconnects. The Worker keeps the
work alive with `waitUntil`.

The dashboard Publish menu shows these stages as Preparing, Building,
Optimizing, and Live. Publish starts with one click, and the menu cannot close
while a publish runs.

If `main` changes before the transaction commits, publication returns
`branch_behind`. If the branch changes, publication returns `conflict`.

### Manual versions are not generation baselines

A branch publication has no source revision or source tree hash. Its generation
state prefix uses `sites/<siteId>/content-versions/<versionId>`.

The baseline resolver requires a generation state prefix and a source revision.
It cannot select a branch publication as a generation baseline.

This rule prevents a later incremental generation from reusing stale repository
content. The next generation analyzes the repository from the start.

Manual edits are not written to the repository. A later full generation can
replace them.

## Code Map

| Layer | Location |
| --- | --- |
| Content and edit contracts | `packages/contracts/src/docs-content.ts` |
| Branch contracts and paths | `packages/contracts/src/docs-branches.ts` |
| Database schema | `packages/db/src/schema/doxa.ts` |
| Branch authorization and reads | `apps/api/src/repositories/docs-branches.ts` |
| Branch writes and synchronization commit | `apps/api/src/repositories/docs-branch-writes.ts` |
| Publication transaction | `apps/api/src/repositories/docs-branch-publication.ts` |
| Content behavior | `apps/api/src/services/docs-content/service.ts` |
| Effective tree | `apps/api/src/services/docs-branches/effective-tree.ts` |
| Publication materializer | `apps/api/src/services/docs-branches/materialize-branch.ts` |
| Content routes | `apps/api/src/routes/docs-content.ts` |
| Branch routes | `apps/api/src/routes/docs-branches.ts` |
| History routes | `apps/api/src/routes/docs-history.ts` |
| Editor state | `apps/web/src/lib/dashboard/use-project-content.ts` |
| Branch state | `apps/web/src/lib/dashboard/use-branch-context.ts` |
| Editor UI | `apps/web/src/components/dashboard/content/` |
| Shared prose rendering | `packages/docs-prose` |

## HTTP Surface

All routes require the current project owner. A branch UUID from the client is
never sufficient for authorization.

### Content routes

These routes use `/projects/:projectId/content`.

| Method | Path | Branch input | Purpose |
| --- | --- | --- | --- |
| `GET` | `/` | `branch` query | Read the page list, site settings, and working summary. |
| `GET` | `/page?href=...` | `branch` query | Read the published and working source for one page. |
| `POST` | `/edits` | `branch` body field | Apply an ordered edit list. |

### Branch routes

These routes use `/projects/:projectId/branches`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | List named branches and the plan limit. |
| `POST` | `/` | Create a named branch from `main` or another branch. |
| `PATCH` | `/:branchId` | Rename a named branch. |
| `DELETE` | `/:branchId` | Erase a named branch and its preview channel. |
| `GET` | `/:branchRef/status` | Read the main, branch, change, and preview status. |
| `GET` | `/:branchRef/sync` | Compute conflicts and automatic resolutions. |
| `GET` | `/:branchRef/sync/diff?key=...` | Read the three sides of one conflict. |
| `POST` | `/:branchRef/sync` | Apply conflict resolutions and move the base. |
| `POST` | `/:branchRef/publish` | Publish the effective tree into `main`. Streams its stages with `accept: text/event-stream`. |
| `POST` | `/:branchRef/preview` | Build or rebuild the branch preview. |
| `POST` | `/:branchRef/discard` | Discard working changes. |

### History routes

These routes use `/projects/:projectId/history`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/?cursor=...&limit=...` | List publications, newest first. |
| `POST` | `/:publicationId/restore` | Move `main` to an earlier production version. |

## Editor UI

The branch switcher stores the selected branch for each project. It returns to
`main` when that branch no longer exists.

The editor autosaves after 1.2 seconds of idle time. It also saves on `Cmd+S`
and before a page switch. Publication flushes the current buffer first.

The source pane and preview pane use the same buffer. The preview uses
`@doxahq/docs-prose`, which the published renderer also uses.

CodeMirror and Shiki load on demand. Invalid MDX shows an error in the preview
pane and keeps the editor mounted.

## Tests

| Area | Main coverage |
| --- | --- |
| Content service | `apps/api/tests/services/docs-content.test.ts` |
| Branch flow | `apps/api/tests/services/docs-branch-flow.test.ts` |
| HTTP authorization | `apps/api/tests/http/docs-content.test.ts` and `docs-branch-actions.test.ts` |
| Dashboard API | `apps/web/tests/docs-content-api.test.ts` |
| Dashboard branch UI | `apps/web/tests/docs-branch-dashboard.test.tsx` |
| Shared rendering | `packages/docs-prose/tests/` |
