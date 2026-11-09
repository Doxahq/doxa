# Documentation Branching

**Status:** Implemented

**Last reviewed:** 2026-10-11

## Purpose

Doxa stores documentation work in branches. A branch holds working changes
until a user publishes them into `main`.

This document describes branch storage, synchronization, conflicts,
publication history, previews, limits, and database locks.

## Branch Model

`main` is the version in `docs_sites.published_version_id`. The production site
serves this immutable version.

A branch stores a base version and a sparse set of working changes. Its
effective tree is the base tree with those changes applied.

The system has two branch kinds:

| Kind | Use | User-visible |
| --- | --- | --- |
| Named | Independent work created from `main` or another named branch. | Yes |
| Hidden | Working changes made while the editor shows `main`. | No |

Each user and site can have one hidden branch. The first edit in `main` creates
it. Publication or discard erases it.

A named branch also has a purpose:

| Purpose | Use |
| --- | --- |
| `user` | Work that a person or an agent created. |
| `generation_review` | The output of a production generation that waits for a review. See [Generation reviews](generation-reviews.md). |
| `generation_backup` | The site that a reviewed generation replaced. |

Only `user` branches count toward the branch limit.

A named branch has a custom name. The name uses lowercase letters, numbers,
and single hyphens. It has 1 to 40 characters.

The reserved names are `main`, `head`, `hidden`, `preview`, and `draft`.

## Working Changes

One `docs_branch_changes` row stores the current change for one artifact path.
The row is an upsert or a deletion.

The accepted paths cover these conflict areas:

- Page source: `source/**/index.mdx`
- Site structure: `manifest.json`, `settings/sections.json`, and `settings/documents*.json`
- Site settings: `settings/site.json`
- Images: `assets/{name}`. The row holds a pointer to the upload folder, not
  the image. Agents add them with `upload_asset`; see
  [MCP server](mcp-server.md#branch-images). Synchronization keeps the branch
  image and reports no conflict for it. The branch diff lists images in
  `assets`.

An edit that equals the base removes its row. This rule keeps the branch sparse.

### Home Page

The site root (`/`) shows the page in `homePage` of `settings/site.json`. If
the field is absent, or names no page, the root shows the first page of the
default section. `resolveHomeHref` in `@doxahq/site-config` holds this rule.
The runtime, the template, and the dashboard all use it.

- The `set_home_page` edit sets the field, or removes it with `href: null`.
  It needs `site.write`. The dashboard sends it from the page menu ("Set as
  default page") and from Site settings → Navigation.
- The field stores an href, not a position, so a reorder does not change it.
- A rename or a move of the home page updates the field in the same save. A
  delete removes the field.
- The value is part of the published version. A change goes live on publish,
  and a rollback restores the old home page.

Each write increments `docs_branches.revision`. A preview stores the revision
that it contains in `preview_revision`.

## Synchronization

A branch is behind when its base version differs from the current version of
`main`. A behind branch cannot publish.

Synchronization compares three trees:

- The branch base
- The current `main`
- The branch effective tree

For each changed path, the plan can keep the branch change, remove it, or report
a conflict. Equal changes on both sides do not create a conflict.

The synchronization request contains `expectedMainVersionId`. The database
checks this value under the site lock.

The service carries the branch base and revision from the computed plan into
the commit. If either value changes, the client must compute a new plan.

## Conflicts

Conflicts use whole files. The service does not do a line merge.

Each page source is one conflict unit. Site settings are one separate conflict
unit.

All structure files form one conflict unit. This rule prevents a result that
mixes a manifest from one side with navigation from the other side.

A resolution is `mine` or `main`. The request can set one resolution for each
conflict or one default for unresolved conflicts.

After it applies the resolutions, the service validates the complete tree. It
rejects missing page sources, orphan page sources, and invalid structure data.

## Publication

Publication is a squash merge into `main`. The resulting immutable version is
the commit.

A publish request includes these concurrency values:

- `expectedBaseVersionId`
- `expectedRevision`
- `eraseBranch`

A changed page that fails the MDX check blocks the publish with
`mdx_invalid` (HTTP 422, `details.pages`), for named branches and for the
hidden branch of `main` alike. Saves are never blocked: the dashboard save
returns the issues, and `GET /projects/:projectId/content/mdx-issues` lists
the blocked pages. See [MCP server](mcp-server.md#mdx-check).

The API materializes R2 artifacts before it starts the publication transaction.
The new version reuses the blobs of its base version, so a publish writes only
the changed pages and the rebuilt manifest, settings, navigation, and search
files. See [Docs Content Storage](docs-content-storage.md).
The transaction checks the same values again under database locks.

The transaction inserts the version, moves `main`, and records one publication.
It also enqueues cache invalidation and pre-render work.

A hidden branch is always erased. A named branch can be erased or reset to the
new version with no working changes.

## Publication History

`docs_publications` records every move of `main`. The record includes the new
version, the previous version, the actor, the kind, and a summary.

The publication kinds are:

- `import`
- `generation`
- `starter`
- `editor`
- `promotion`
- `restore`

The history API lists records from newest to oldest. Its cursor includes the
creation time and publication ID.

A restore moves `main` to the production version of an older publication. It
does not change or erase any branch.

A restore records a new `restore` publication. Every existing branch then
compares its base against the restored head.

## Branch Previews

Each branch can have one preview channel. The channel has a stable hostname and
points to its latest preview version.

A build reads a branch snapshot without locks. It then materializes the
effective tree into a preview version.

The final transaction locks the site and branch. It moves the preview channel
only when the branch is still valid.

A later edit makes the preview outdated. The dashboard builds a new preview
when the user selects Preview again.

The API accepts one preview build for a branch every 10 seconds. A faster
request returns `preview_rate_limited`.

Branch previews use the same access policy as generation previews. The current
preview gate is disabled, so these previews are public.

When a channel moves, garbage collection queues the old preview version. When a
branch is erased, the channel is erased and collection can start at once.

## Limits

| Limit | Value |
| --- | --- |
| Named branches for each site | 10 on the free plan |
| Branch name | 1 to 40 characters |
| Changed paths for each branch | 2,000 |
| Changed content for each branch | 32 MiB |
| One page source | 512 KiB |
| Images for each branch | 50, 2 MB each, within the plan storage |
| Preview builds for each branch | One every 10 seconds |

The branch count comes from project entitlements. Hidden branches do not count
toward this limit.

## Lock Order

Transactions that need a site row and a branch row use this order:

1. Lock `docs_sites`.
2. Lock `docs_branches`.

Publication, synchronization, branch management, and preview channel commits
obey this order. Restore locks only the site row.

A transaction that also needs a generation review locks the review row after
the branch row.

This order prevents cycles between site-wide and branch-specific operations.

A normal content edit locks only its branch row. It does not lock the site, so
edits on separate branches can continue in parallel.

R2 materialization does not run while these database locks are held. The final
transaction performs short compare-and-set checks and database writes.

## Authorization

Every repository lookup joins a branch to its site and project. It also filters
by the session user.

The API returns `404` for a branch outside the owned project. It does not expose
artifact prefixes or R2 keys.

Only dashboard actions can erase branches. Agents publish branches and restore
publications only through the agent action gateway, under the approval policy.
See [Agent actions and approvals](agent-actions.md).

## Related Files

- [`docs/docs-content-editor.md`](../docs-content-editor.md)
- [`docs/current/storage-garbage-collection.md`](storage-garbage-collection.md)
- [`packages/contracts/src/docs-branches.ts`](../../packages/contracts/src/docs-branches.ts)
- [`apps/api/src/services/docs-branches/`](../../apps/api/src/services/docs-branches/)
- [`apps/api/src/repositories/docs-branch-writes.ts`](../../apps/api/src/repositories/docs-branch-writes.ts)
- [`apps/api/src/repositories/docs-branch-publication.ts`](../../apps/api/src/repositories/docs-branch-publication.ts)
