# Docs branching

Status: design approved in conversation, not implemented.
Date: 2026-09-24.
Decision: Git-style branches for docs content, stored in Postgres and R2. A commit happens only on publish. A publish is a squash merge into `main`.

This spec is the second of two. It depends on "Site config and artifact schema v2" (`docs/superpowers/specs/2026-09-23-site-config-and-artifact-schema-v2-design.md`). Read that spec first. This spec reuses its issue model, its entitlements, and its artifact writer.

Implement without subagents. Follow the project clean-code skill (`i-coderone-clean-code`) and the repository instructions in `AGENTS.md`. Security, correctness under concurrency, and clean code are acceptance criteria in this spec, not optional polish.

This handoff describes implementation work. It does not authorize a commit, a deployment, a migration run, or an R2 cleanup run. Get explicit approval for each of these.

Doxa has no customers yet. Downtime between phases is acceptable. The existing content drafts can be discarded (section 13).

## 1. Goal and scope

Let a project owner work on docs content in branches, and publish a branch to the live site.

- `main` is the default branch. It is the content that the live site shows.
- A user can create a named branch from `main` or from another named branch.
- A branch holds separate content: page sources, the site structure, and the site settings.
- A publish of a branch merges it into `main` and publishes `main`, as a publish does today.
- Edits in the `main` view go to a hidden branch. The user never sees this branch.
- If `main` changes after a branch starts, the dashboard warns the user and asks for a synchronization with the latest `main`.
- Each branch can have a preview URL.

### In scope

- Database tables for branches, working changes, and the publication history.
- The branch service in `apps/api`: create, rename, erase, fork, edit, discard, synchronize, publish, preview, history, and restore.
- File-level conflict detection and resolution: "keep mine" or "keep main", for each conflict or for the whole branch.
- A limit of named branches for each site, from the entitlements (default 10).
- Branch previews on the existing preview channel system.
- The dashboard: branch switcher, "main changed" warning, synchronization dialog, publish dialog, history panel, preview control, and branch management dialog.
- Removal of the R2 draft overlay (`sites/<siteId>/drafts/current`).

### Explicit exclusions

- NO line-level merge. A file that changed on both sides is a conflict. Automatic line merge (diff3) is a follow-up.
- NO structural merge of JSON files. The site structure and the site settings are whole-file conflict units in this version.
- NO branch expiry.
- NO team or member model. The project owner is the only user of a project, as today.
- NO Git server, Git protocol, or export to Git.
- NO content-addressed object store. Section 3 explains why.
- NO change to how generation writes versions, other than the publication history record.
- NO change to the renderer, the runtime, or the artifact schema.

## 2. Repository facts

These facts were checked in the code on 2026-09-24.

| Fact | Location |
|---|---|
| A draft is a sparse overlay in R2 at `sites/<siteId>/drafts/current/`. Its metadata holds `baseVersionId`, `editedHrefs`, and `structureChanged`. | `packages/docs-engine/src/index.ts` (`buildDraftPrefix`, `docsDraftMetaSchema`) |
| The draft overlay covers `source/**`, `manifest.json`, `settings/sections.json`, and the navigation files `settings/documents*.json`. Search files are rebuilt at publish. | `apps/api/src/services/docs-content/service.ts` `isEffectiveContentArtifact` |
| A publish writes a new version prefix from the base version plus the overlay, copies every other base object, and then promotes the version under a row lock with a compare-and-swap on `published_version_id`. | `DocsContentService.publishDraft`, `DocsContentRepository.createContentVersion` |
| If a generation publishes while a draft is open, the draft publish fails with HTTP 409, and the only choice is to discard the draft. | `publishDraft`, `apps/api/src/services/docs-content/errors.ts` |
| Every content mutation is one edit list (`docsContentEditSchema`) with an `origin` of `editor`, `agent`, or `mcp`. Structure edits exist: create, rename, move, and delete for sections, groups, and pages. | `packages/contracts/src/docs-content.ts` |
| The content service authorizes through project ownership and never trusts a client site ID or prefix. | `DocsContentRepository.getPublishedVersionForUser` |
| Three code paths move `docs_sites.published_version_id`: generation publish, generation promotion, and the content editor publish. | `apps/api/src/repositories/docs.ts` `publishJob`, `apps/api/src/repositories/jobs.ts` `promoteForProject`, `apps/api/src/repositories/docs-content.ts` `createContentVersion` |
| All three run inside `withDocsPublicationEffects`, which enqueues the cache purge and the prerender task. | `apps/api/src/repositories/docs-cache-mutation.ts` |
| `docs_versions.baseline_version_id` is the generation baseline. It is `null` after a generation cache reset, so it is not a reliable parent pointer. | `packages/db/src/schema/doxa.ts` |
| Preview channels map a hostname to a version with compare-and-swap (`compareAndSetVersion`). A channel requires `provider` and `change_external_id`. The only provider is `github`. | `apps/api/src/repositories/preview-channels.ts`, `packages/db/src/schema/doxa.ts` |
| Pull request preview hostnames are `<slug>-pr-<n>` plus an optional digest suffix, with a namespace check against projects, sites, previews, and custom domains. | `createPreviewHostnameCandidates`, `apps/api/src/services/docs-namespace.ts` |
| A preview channel resolves with the public access policy today. Generation previews use `resolveDocsAccessPolicy` with the site `preview_visibility`. The preview gate is off, so all previews are public. | `preview-channels.ts` `resolveByHostname`, `apps/api/src/services/docs-access.ts` |
| Storage GC accepts new collectors with no migration: a resource schema, a collector, a registration, and an enqueue call. | `docs/current/storage-garbage-collection.md` |
| Spec 1 put the issue model in `packages/contracts/src/validation.ts` and the message table in `packages/site-config/src/validation/messages.ts`. | Working tree on 2026-09-24 |
| Spec 1 put the entitlements in `packages/contracts/src/entitlements.ts`. | Working tree on 2026-09-24 |

## 3. Design decisions

1. **A version is a commit.** A commit happens only on publish. A publish already writes an immutable version prefix, so a published version is the commit. The publication history table (section 5.4) records each move of `main`, with the actor, the kind, and a summary.
2. **No content-addressed object store in this version.** Commits happen only on publish, and each publish already writes a full immutable prefix. A separate blob store adds work and no function now. A later artifact schema can store page bodies by hash, to make a publish copy less data. That change does not affect this design.
3. **Working changes live in Postgres.** A working change is one row for each changed file, with the file content. Edits, synchronization, publish, and erase then run in database transactions. There are no orphan files, and an erase is a cascade delete. Pages are 512 KiB or less, and a branch has limits (section 9.4), so the size is bounded.
4. **The merge base is the fork point.** Each branch stores `base_version_id`, the version of `main` that it started from, or that it last synchronized with. A three-way comparison uses the base, the current `main`, and the branch. This works even after a promotion or a restore moves `main` to an older version, because the base is a fixed snapshot and not an ancestor search.
5. **Synchronization merges. Publish requires an up-to-date branch.** A branch is behind when its base is not the current `main`. The user must synchronize before a publish. After synchronization, a publish is a fast-forward: it writes the base plus the working changes as the new version. This is the squash merge.
6. **Conflicts are file-level.** A file that changed on the branch and on `main` in different ways is a conflict. The user picks "keep mine" or "keep main" for each conflict, or for the whole branch.
7. **The site structure is one conflict unit.** `manifest.json`, `settings/sections.json`, and every `settings/documents*.json` describe one structure. They are resolved together, never file by file, so a resolution cannot mix two structures.
8. **Hidden branches make `main` editable.** An edit in the `main` view goes to a hidden branch, one for each user and site. It is created at the first edit and erased after publish or discard.
9. **Authorization always goes through the project.** A branch ID from a client is never enough. Every query joins the branch to its site and project, and filters by the session user.

## 4. Concepts and vocabulary

Use these terms in code, API, UI, and docs. Do not use synonyms.

| Term | Meaning |
|---|---|
| **main** | The published content of a site. Its head is `docs_sites.published_version_id`. |
| **branch** | A named or hidden line of work: a base version plus working changes. |
| **named branch** | A branch that the user created and can see. It counts toward the branch limit. |
| **hidden branch** | The branch that holds the user's edits in the `main` view. The UI never shows it as a branch. |
| **base** | `docs_branches.base_version_id`. The version of `main` that the branch compares against. |
| **working change** | One row in `docs_branch_changes`: a file path with new content, or a deletion. |
| **effective tree** | The files of the base version with the working changes applied. |
| **behind** | The branch base is not the current head of `main`. |
| **synchronize** | Move the base to the current `main`, and resolve any conflicts. |
| **conflict unit** | One thing that the user resolves: one page file, the site structure, or the site settings. |
| **publish** | Write the effective tree as a new version, move `main` to it, and record a publication. |
| **publication** | One row in `docs_publications`: one move of `main`. |
| **restore** | Move `main` back to an earlier published version, as a new publication. |
| **erase** | Delete a branch, its working changes, and its preview. It cannot be undone. |

## 5. Data model

All tables are in `packages/db/src/schema/doxa.ts`. Generate the migration with `pnpm db:generate`. Ask the user before you run it.

### 5.1 `docs_branches`

```ts
export const docsBranchKind = pgEnum("docs_branch_kind", ["named", "hidden"]);

export const docsBranches = pgTable(
  "docs_branches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => docsSites.id, { onDelete: "cascade" }),
    kind: docsBranchKind("kind").notNull(),
    /** Named branches only. Lowercase, unique per site. */
    name: text("name"),
    /** The user who created a named branch, or the owner of a hidden branch. */
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    baseVersionId: uuid("base_version_id")
      .notNull()
      .references(() => docsVersions.id),
    createdFromBranchId: uuid("created_from_branch_id").references(
      (): AnyPgColumn => docsBranches.id,
      { onDelete: "set null" },
    ),
    /** Increments on every change to the working changes or the base. */
    revision: integer("revision").notNull().default(0),
    /** The revision of the last preview build, or null. */
    previewRevision: integer("preview_revision"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("docs_branches_site_name_idx")
      .on(table.siteId, table.name)
      .where(sql`${table.kind} = 'named'`),
    uniqueIndex("docs_branches_site_hidden_owner_idx")
      .on(table.siteId, table.ownerUserId)
      .where(sql`${table.kind} = 'hidden'`),
    index("docs_branches_site_id_idx").on(table.siteId),
    check(
      "docs_branches_name_matches_kind",
      sql`(${table.kind} = 'named' AND ${table.name} IS NOT NULL)
       OR (${table.kind} = 'hidden' AND ${table.name} IS NULL)`,
    ),
  ],
);
```

- `base_version_id` has no cascade. A version that a branch uses as its base cannot be deleted.
- The storage GC must never collect a version that any branch uses as its base.

### 5.2 `docs_branch_changes`

```ts
export const docsBranchChangeKind = pgEnum("docs_branch_change_kind", [
  "upsert",
  "delete",
]);

export const docsBranchChanges = pgTable(
  "docs_branch_changes",
  {
    branchId: uuid("branch_id")
      .notNull()
      .references(() => docsBranches.id, { onDelete: "cascade" }),
    /** A path that `branchPathSchema` accepts. Relative to the version prefix. */
    path: text("path").notNull(),
    kind: docsBranchChangeKind("kind").notNull(),
    content: text("content"),
    /** SHA-256 hex of the UTF-8 content. Null for a deletion. */
    contentSha256: text("content_sha256"),
    byteSize: integer("byte_size").notNull().default(0),
    updatedByUserId: text("updated_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    origin: text("origin").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.branchId, table.path] }),
    check(
      "docs_branch_changes_content_matches_kind",
      sql`(${table.kind} = 'upsert' AND ${table.content} IS NOT NULL AND ${table.contentSha256} IS NOT NULL)
       OR (${table.kind} = 'delete' AND ${table.content} IS NULL AND ${table.contentSha256} IS NULL)`,
    ),
  ],
);
```

- `origin` holds a `DocsContentEditOrigin` value, validated by the service.
- One row for each path. An edit to the same path replaces the row.
- If an edit makes a file equal to its base content, the service deletes the row. A branch then shows only real changes.

### 5.3 `docs_versions`: no change

A version needs no new column. The publication history holds the parent link (`previous_version_id`). Do not use `baseline_version_id` for branching.

### 5.4 `docs_publications`

```ts
export const docsPublicationKind = pgEnum("docs_publication_kind", [
  "import",      // backfill: the head of main when branching shipped
  "generation",
  "starter",
  "editor",      // a branch publish
  "promotion",   // the existing generation promote action
  "restore",
]);

export const docsPublications = pgTable(
  "docs_publications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => docsSites.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => docsVersions.id),
    previousVersionId: uuid("previous_version_id").references(() => docsVersions.id),
    kind: docsPublicationKind("kind").notNull(),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    /** Display name of a named branch at publish time. Null for other kinds. */
    branchName: text("branch_name"),
    /** Validated with `docsPublicationSummarySchema`. */
    summary: jsonb("summary").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("docs_publications_site_created_idx").on(table.siteId, table.createdAt),
  ],
);
```

```ts
export const docsPublicationSummarySchema = z.object({
  changedPageCount: z.number().int().nonnegative().optional(),
  /** Up to 20 page titles, for the history list. */
  pageTitles: z.array(z.string().max(200)).max(20).optional(),
  structureChanged: z.boolean().optional(),
  siteSettingsChanged: z.boolean().optional(),
  /** For a restore: the publication that the user restored. */
  restoredPublicationId: z.string().uuid().optional(),
}).strict();
```

- A shared helper `recordPublication(tx, input)` in `apps/api/src/repositories/docs-publications.ts` writes the row.
- Every code path that moves `published_version_id` calls it inside the same transaction: `publishJob`, `promoteForProject`, the branch publish, and restore. Add the call to the first two. Do not change their other behavior.
- Add a test that fails if a new code path moves `published_version_id` without a publication row. For example, a repository-level test that runs each path and counts the rows.

### 5.5 `docs_preview_channels`: branch channels

```ts
export const docsPreviewChannelKind = pgEnum("docs_preview_channel_kind", [
  "source_change",
  "branch",
]);
```

Changes to the table:

- Add `kind` with the default `"source_change"`.
- Add `branchId: uuid("branch_id").references(() => docsBranches.id, { onDelete: "cascade" })`, with a unique index.
- Make `provider` and `change_external_id` nullable.
- Add a check: `(kind = 'source_change' AND provider IS NOT NULL AND change_external_id IS NOT NULL AND branch_id IS NULL) OR (kind = 'branch' AND branch_id IS NOT NULL AND provider IS NULL AND change_external_id IS NULL)`.
- The existing unique index on `(project_id, site_id, provider, change_external_id)` stays. Postgres treats null values as distinct, so branch rows do not collide.
- Update `PreviewChannelRecord` to a discriminated union on `kind`. Code that reads `provider` must narrow the type first. Do not use a non-null assertion.

### 5.6 Entitlements

Add one field to `projectEntitlementsSchema` in `packages/contracts/src/entitlements.ts`:

```ts
export const projectEntitlementsSchema = z.object({
  removePoweredBy: z.boolean(),
  maxBranchesPerSite: z.number().int().positive().max(1000),
}).strict();

export const FREE_PLAN_ENTITLEMENTS = {
  removePoweredBy: false,
  maxBranchesPerSite: 10,
} as const satisfies ProjectEntitlements;
```

- The limit counts named branches only. Hidden branches do not count, because the user cannot see them. There is at most one hidden branch for each user and site.
- The limit is read through `EntitlementsService.getProjectEntitlements` from Spec 1. A billing change later changes only that service.
- If a plan lowers the limit below the current count, the existing branches stay. The user cannot create a new branch until the count is below the limit.

## 6. Paths and conflict units

### 6.1 Allowed paths

`packages/contracts/src/docs-branches.ts` defines `branchPathSchema`. A working change can use only these paths:

| Path | Kind |
|---|---|
| `source/index.mdx` | Page |
| `source/<segments>/index.mdx`, where each segment matches `DOCS_PAGE_SLUG_PATTERN` segments | Page |
| `manifest.json` | Structure |
| `settings/sections.json` | Structure |
| `settings/documents.json` (the default section), `settings/documents.<section-slug>.json`, where the slug matches `DOCS_SECTION_SLUG_PATTERN` | Structure |
| `settings/site.json` | Site settings |

- Build the page path from the href with the existing `sourcePathForHref`. Do not build paths by string concatenation in other places.
- `navigationPathForSection` and `documentSectionSlug` are private functions in `apps/api/src/services/docs-content/service.ts` today. Move them to `packages/docs-engine/src/index.ts`, next to `documentsPathForPrefix`, and export them. The path schema, the service, and the materializer then share one implementation. Add a relative-path variant (with no prefix) for the path schema.
- The schema rejects `..`, `.`, empty segments, backslashes, a leading `/`, percent-encoded characters, uppercase letters, and any other file.
- `search/*.json` and every other artifact file are derived at publish time. They can never be a working change.
- `classifyBranchPath(path): "page" | "structure" | "site_settings"` is the only function that maps a path to its kind. The conflict logic uses it.

### 6.2 Conflict units

| Unit | Key | Paths |
|---|---|---|
| Page | `page:<href>` | One `source/**/index.mdx` path |
| Structure | `structure` | Every structure path, as one unit |
| Site settings | `site_settings` | `settings/site.json` |

The key is stable. The API uses it in synchronization requests, and the UI uses it for React keys and tests.

## 7. Synchronization and conflicts

### 7.1 The comparison

A synchronization compares three versions of each relevant path:

- **base:** the file in the branch base version, or absent,
- **main:** the file in the current head of `main`, or absent,
- **mine:** the working change: new content, or a deletion.

Only paths with a working change can conflict. A path that changed only on `main` needs no action, because the new base contains it. The comparison therefore reads two files for each working change, and no more.

Compare files by SHA-256 of the exact bytes. An absent file has the hash `null`.

### 7.2 The decision table

`computeSyncPlan` is a pure function in `apps/api/src/services/docs-branches/sync-plan.ts`. It has no I/O.

| main vs base | mine vs main | Decision |
|---|---|---|
| main = base (main did not change this path) | any | `keep_change`: the row stays and overrides the new base |
| main ≠ base | mine = main | `drop_change`: the new base already has this content |
| main ≠ base | mine ≠ main | `conflict` |

A deletion in `mine` compares as `null`. A deletion on both sides is therefore `drop_change`.

### 7.3 Units

- A page unit uses the table directly.
- The site settings unit uses the table directly.
- The structure unit is one decision for the whole group:
  - If every structure path with a working change is `keep_change` or `drop_change`, apply the decisions path by path. Also: if `main` changed any structure path that the branch did not change, and the branch changed another structure path, the result is `conflict`. Two structures from two sources must not mix.
  - Otherwise the unit is `conflict`.

### 7.4 Resolutions

| Resolution | Page or site settings unit | Structure unit |
|---|---|---|
| `mine` | Keep the row. | Pin the whole branch structure. Write a row for each structure path with the content from the branch effective tree, including paths that the branch did not change. |
| `main` | Delete the row. | Delete every structure row. |

The request can give one resolution for each unit, and a default for every unit that has no explicit resolution:

- **"Keep all mine" (overwrite):** `defaultResolution: "mine"`.
- **"Keep all main" (fast synchronization):** `defaultResolution: "main"`.

### 7.5 Validation of the result

Before the synchronization commits, the service validates the new effective tree (new base plus the resolved changes):

| Check | Severity | Code |
|---|---|---|
| Every href in the navigation files and in the manifest has a source file | Error | `structure_missing_page` with `{ href }` |
| A source file has no entry in the navigation or the manifest | Warning | `orphan_page` with `{ href }` |
| Exactly one default section exists | Error | `structure_invalid` |
| `settings/site.json` passes `parseSiteConfigStrict` | Error | the Spec 1 codes, with the pointer under `/settings/site.json` |

- If an error exists, the synchronization does not commit. The API returns HTTP 422 with the issues. The user picks a different resolution, or corrects the branch first.
- Reuse the structure parsing in `apps/api/src/services/docs-content/structure.ts` (`contentStructureFromArtifacts`). Do not write a second parser.

### 7.6 The synchronization transaction

1. Lock the branch row (`SELECT … FOR UPDATE`).
2. Read `docs_sites.published_version_id`. It must equal `expectedMainVersionId` from the request. If it does not, return HTTP 409 `main_changed` with the new head. The client shows the new conflicts.
3. Compute the plan from the rows and the two versions.
4. If a conflict has no resolution and there is no default, return HTTP 409 `conflicts_unresolved` with the conflict list. Change nothing.
5. Apply the decisions and resolutions to the rows.
6. Validate the result (section 7.5).
7. Set `base_version_id` to the main head, and increment `revision`.
8. Commit.

The request is stateless. The server computes the conflicts again for each request. No conflict state is stored between requests.

### 7.7 Conflict details for the UI

`GET /branches/:branchId/sync` returns the plan without a change (a dry run):

```ts
type SyncPreview = {
  mainVersionId: string;
  behind: boolean;
  conflicts: ConflictDto[];
  autoResolvedCount: number;   // keep_change + drop_change
};

type ConflictDto =
  | { unit: "page"; key: `page:${string}`; href: string; title: string;
      mine: "modified" | "deleted"; main: "modified" | "deleted" }
  | { unit: "structure"; key: "structure" }
  | { unit: "site_settings"; key: "site_settings" };
```

`GET /branches/:branchId/sync/diff?key=<key>` returns the three contents of one unit (base, main, mine), so the dialog can show them side by side. For the structure unit, it returns the page lists and the navigation titles, not the raw JSON.

## 8. Operations

All operations live in `DocsBranchService` (section 11). Each operation authorizes through the project, as section 9.1 describes.

### 8.1 Branch resolution

Every content request names a branch with `branch`:

```ts
export const branchRefSchema = z.union([
  z.literal("main"),
  z.string().uuid(),
]);
```

- `"main"` means the hidden branch of the session user for this site.
  - A read with no hidden branch returns the `main` head with no changes. It does not create a branch.
  - The first write creates the hidden branch, with an insert that ignores a unique-index conflict, followed by a select. Two parallel first writes therefore create one branch.
- A UUID must be a named branch of the same site. Otherwise the result is 404. The response never tells whether a branch exists in another project.

### 8.2 Edits

- `POST /edits` gets a `branch` field. It keeps the current edit operations, including `set_site_config` from Spec 1.
- The service applies the edits to the effective tree of the branch, and writes the changed paths as rows in one transaction. Then it increments `revision`.
- Structure edits keep their current logic in `structure.ts`. Only the storage changes: the service writes the new structure files and page bodies as rows, not as R2 draft objects.
- `reset_page` deletes the row of that page. `reset_site_config` deletes the row of `settings/site.json`.

### 8.3 Discard

`POST /branches/:branchId/discard` deletes every row of the branch and increments `revision`.

- For a hidden branch (`branch: "main"`), discard erases the branch.
- For a named branch, the branch stays empty.

### 8.4 Create and fork

`POST /branches` with `{ name, from: { kind: "main" } | { kind: "branch", branchId } }`:

1. Validate the name (section 9.3).
2. In one transaction, lock the `docs_sites` row. Then count the named branches and compare with `maxBranchesPerSite`. If the count is at the limit, return HTTP 422 `branch_limit_reached` with `{ max }`.
3. From `main`: `base_version_id` is the current head. There are no rows.
4. From a named branch: `base_version_id` is the base of the source branch. Copy every row of the source branch with `INSERT … SELECT`. Set `created_from_branch_id`.

The site row lock makes the count and the insert atomic. Two parallel creations cannot pass the limit.

### 8.5 Rename and erase

- `PATCH /branches/:branchId` with `{ name }` renames a named branch. The name rules apply.
- `DELETE /branches/:branchId` erases a named branch. In one transaction, it enqueues the GC of its preview version (section 10.4) and then deletes the branch row. The rows and the preview channel go with the cascade.
- A hidden branch cannot be renamed or erased through these routes. Use discard.

### 8.6 Publish

`POST /branches/:branchId/publish` (or `branch: "main"`) with `{ expectedBaseVersionId, eraseBranch }`:

1. Read the branch. It must have at least one row. Otherwise return HTTP 422 `no_changes`.
2. The branch base must equal `expectedBaseVersionId` and the current `main` head. Otherwise return HTTP 409 `branch_behind`. The client opens the synchronization dialog.
3. Validate the effective tree (section 7.5) and the site config entitlements (Spec 1 section 6.9).
4. Write the new version prefix with the materializer (section 8.9). This step runs before the transaction, as the current publish does.
5. In one transaction, inside `withDocsPublicationEffects`:
   1. Lock the site row and check `published_version_id = base` again.
   2. Insert the version row.
   3. Move `published_version_id`.
   4. Record the publication (`kind: "editor"`) with the summary.
   5. If `eraseBranch` is true, or the branch is hidden: enqueue the preview GC and delete the branch.
   6. Otherwise: delete every row, set `base_version_id` to the new version, and increment `revision`.
6. Return `{ versionId, versionNumber, publicationId, branchErased }`.

- `eraseBranch` has no default in the API. The client must send it. The dialog has the checkbox on by default.
- If step 5 fails, the prefix from step 4 is an orphan. The current publish has the same gap. Section 10.4 adds a collector for it.

### 8.7 History

`GET /history?cursor=&limit=` returns the publications of the site, newest first, 25 for each page:

```ts
type PublicationDto = {
  id: string;
  kind: DocsPublicationKind;
  versionId: string;
  versionNumber: number;
  actor: { id: string; name: string } | null;
  branchName: string | null;
  summary: DocsPublicationSummary;
  createdAt: string;
  isCurrent: boolean;
  canRestore: boolean;
};
```

- `canRestore` is true if the version is a production version of this site, its artifacts still exist, and it is not the current head.
- The cursor is opaque: base64url of `createdAt` and `id`. The server validates it and never uses it in raw SQL.

### 8.8 Restore

`POST /history/:publicationId/restore` with `{ expectedMainVersionId }`:

1. Resolve the publication through the project. It must belong to this site, and `canRestore` must be true.
2. In one transaction, inside `withDocsPublicationEffects`:
   1. Lock the site row. The head must equal `expectedMainVersionId`. Otherwise return 409 `main_changed`.
   2. Move `published_version_id` to the version of the publication.
   3. Record a publication with `kind: "restore"` and `restoredPublicationId`.
3. A restore reuses the existing version. It writes no new artifacts, so the existing caches and prerendered output for that version stay valid.

After a restore, every branch is behind. The warning in section 12.3 reports it.

### 8.9 The materializer

Extract the artifact writing of `publishDraft` into `apps/api/src/services/docs-branches/materialize.ts`:

```ts
export interface MaterializeInput {
  siteId: string;
  base: { versionId: string; artifactPrefix: string };
  changes: readonly BranchChange[];
  targetVersionId: string;
  generatedAt: string;
}

export interface MaterializeResult {
  artifactPrefix: string;
  manifestPath: string;
  summary: DocsPublicationSummary;
}

export function createMaterializer(deps: {
  store: DocsContentStore;
  siteConfigWriter: SiteConfigArtifactWriter;   // from Spec 1
}): (input: MaterializeInput) => Promise<MaterializeResult>;
```

- It keeps the current behavior: sources, manifest, sections, navigation with title patches, search re-index, compiled search, and a copy of the other base objects. It writes artifact schema v2, with the Spec 1 upgrade step for a v1 base.
- The target prefix is always `buildArtifactPrefix(siteId, targetVersionId)`. Both values come from the server.
- Publish and preview use this one function. Do not keep a second copy of the writing logic.

### 8.10 Status for the warning

`GET /branches/:branchRef/status` is a small read for polling:

```ts
type BranchStatusDto = {
  branch: { id: string | null; kind: "named" | "hidden"; name: string | null; revision: number };
  baseVersionId: string;
  main: {
    versionId: string;
    versionNumber: number;
    latestPublication: { kind: DocsPublicationKind; actorName: string | null; createdAt: string };
  };
  behind: boolean;
  publicationsSinceBase: number;
  changeCount: number;
  preview: { hostname: string; upToDate: boolean } | null;
};
```

- `publicationsSinceBase` counts the publication rows of the site that are newer than the newest publication of the base version. If the base has no publication row (a backfill gap), the value is 1 when the branch is behind.
- The query must use indexes only. It runs every 30 seconds for each open editor.

## 9. Security and correctness

### 9.1 Authorization and isolation

- Every branch operation resolves in one query: project ID and session user, then site, then branch. A branch of another site or another user returns 404.
- The service never reads a site ID, a version ID, an artifact prefix, or an R2 key from the request. It reads them from the database through the resolved project.
- A version ID from the request (`expectedBaseVersionId`, `expectedMainVersionId`) is only compared with a database value. It is never used to read data.
- `restore` accepts only a publication of the resolved site.
- The `origin` of an edit is recorded for the audit. It never grants a right. Agent and MCP origins have the same branch rights as the editor. They cannot erase a branch, restore, or publish unless the user action calls the service. Enforce this in the route layer: the branch erase, publish, and restore routes accept the `editor` origin only.

### 9.2 Input validation

- Paths use `branchPathSchema` (section 6.1). The materializer asserts each path again before a write, as a second barrier.
- Page content keeps the 512 KiB limit (`DOCS_CONTENT_MAX_PAGE_BYTES`). `settings/site.json` keeps the 64 KiB limit from Spec 1.
- Structure files have a limit of 256 KiB each.
- The server computes `content_sha256` and `byte_size`. It never accepts them from the client.

### 9.3 Branch names

- A name matches `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`: 1 to 40 characters, lowercase letters, digits, and single hyphens, with no hyphen at either end.
- Reserved names: `main`, `head`, `hidden`, `preview`, `draft`.
- Names are unique for each site (unique index).
- Issue codes: `invalid_branch_name`, `reserved_branch_name`, `branch_name_taken`.
- The name is also used in a preview hostname (section 10.2). The name rules keep it a valid DNS label part.

### 9.4 Limits

| Limit | Value | Code |
|---|---|---|
| Named branches for each site | `maxBranchesPerSite` (10) | `branch_limit_reached` |
| Working changes for each branch | 2,000 rows | `too_many_changes` |
| Total content for each branch | 32 MiB | `branch_too_large` |
| Edits in one request | 100 (existing) | existing |
| Preview builds for each branch | 1 at a time, and at least 10 seconds apart | `preview_rate_limited` (HTTP 429) |

Check the row and size limits inside the edit transaction, after the branch row lock.

### 9.5 Concurrency

| Race | Protection |
|---|---|
| Two edits to one branch | Branch row lock during each edit transaction. The last write for a path wins, as today. |
| Edit during synchronization or publish | The same branch row lock serializes them. After a publish that erased the branch, the edit returns 404 `branch_not_found`. The client shows: "This branch was published and erased." |
| Publish while `main` moves | Site row lock and compare-and-swap on `published_version_id` (existing). The loser gets 409 `branch_behind`. |
| Two branch creations at the limit | Site row lock around the count and the insert. |
| Two first edits on `main` | The unique index on the hidden branch. |
| Preview build while the branch changes | The build stores the revision that it read. `upToDate` compares it with the current revision. |

Lock order is always site row, then branch row. Never lock in the other order. This prevents deadlocks between publish and edit.

### 9.6 Preview exposure

- The preview gate is off today, so a branch preview is public for anyone with the URL. Unpublished content is then readable by anyone who has the link.
- Every branch preview hostname therefore ends with 16 random hex characters (64 bits) from `crypto.getRandomValues`. The hostname cannot be guessed from the project and branch names.
- Branch previews use `resolveDocsAccessPolicy({ isGenerationPreview: true, previewVisibility, gateEnabled })`, the same policy as generation previews. When the gate is on, they become private with no further change.
- Branch preview responses must carry `X-Robots-Tag: noindex, nofollow`. If generation previews already set it, reuse that code path. Otherwise add it for both.
- The preview popover in the dashboard says: "Anyone with this link can view this preview."

### 9.7 Error codes

Extend `DocsContentErrorCode` in `apps/api/src/services/docs-content/errors.ts`, and map each code in `getDocsContentErrorStatus`:

| Code | HTTP |
|---|---|
| `branch_not_found` | 404 |
| `branch_behind` | 409 |
| `main_changed` | 409 |
| `conflicts_unresolved` | 409 |
| `preview_rate_limited` | 429 |

Validation problems use the Spec 1 issue model and HTTP 422 through `validationError(issues)`. Add these codes to `validationIssueCodeSchema` in `packages/contracts/src/validation.ts`, with messages:

`invalid_branch_name`, `reserved_branch_name`, `branch_name_taken`, `branch_limit_reached`, `too_many_changes`, `branch_too_large`, `structure_missing_page`, `structure_invalid`, `orphan_page`.

- The message table in `packages/site-config/src/validation/messages.ts` must cover every code, and the compiler enforces this. These codes are not site config codes. Move the message table to `packages/contracts/src/validation-messages.ts` in phase B1, and keep one table. Update the Spec 1 imports.
- Spec 1 added `draft_stale`. Replace every use with `branch_behind`, then remove `draft_stale` from the enum.
- A 409 body uses the existing `error()` helper with `details: { code, ... }`. Add a typed builder for each 409 code. Do not build the body by hand in routes.

## 10. Branch previews

### 10.1 Build

`POST /branches/:branchRef/preview`:

1. Lock the branch row. Apply the rate limit (section 9.4).
2. Materialize the effective tree into a new version (`channel: "preview"`, `status: "published"`), with the materializer.
3. Create or reuse the branch preview channel (section 10.2).
4. Move the channel to the new version with `compareAndSetVersion`.
5. Enqueue the GC of the previous preview version (section 10.4).
6. Set `preview_revision` to the revision from step 1.
7. Return `{ url, hostname, versionId }`.

A preview build never changes `main`, the site row, or the publication history.

### 10.2 Hostname

Generalize `createPreviewHostnameCandidates` into one helper that takes a stem and an identity:

```ts
export async function createChannelHostnameCandidates(input: {
  stem: string;              // "<slug>-pr-<n>" or "<slug>-br-<name>"
  identity: string;          // for the digest suffixes
  requiredSuffix?: string;   // branch previews: 16 random hex characters
  docsBaseDomain: string | undefined;
  isAvailable(candidate: DocsNamespaceCandidate): Promise<boolean>;
}): Promise<string[]>;
```

- Pull request previews keep their exact current hostnames. Add a test that compares the old and new output for sample inputs.
- Branch stem: `<projectSlug>-br-<branchName>`. Hidden branch stem: `<projectSlug>-br-edits`.
- A branch preview always adds `-<16 random hex>`. `fitHostnameLabel` shortens the stem so that the label stays 63 characters or less.
- The namespace check (`isHostnameAvailable`) applies, as for pull request previews.
- A rename does not change the hostname. The hostname is fixed for the life of the branch.

### 10.3 Resolution

`resolveByHostname` in `preview-channels.ts` returns the version of the channel. For `kind: "branch"`, it uses the access policy of section 9.6. For `kind: "source_change"`, it keeps the current behavior.

### 10.4 Storage GC

Add two collectors, following `docs/current/storage-garbage-collection.md`:

| Target | Resource | Inspect: retained when | Collect |
|---|---|---|---|
| `docs_preview_version` | `{ siteId, versionId }` | Any channel has this version as its current version, OR it is the site head, OR any branch uses it as its base | Delete the version prefix |
| `docs_orphan_version_prefix` | `{ siteId, versionId }` | A `docs_versions` row exists for this ID | Delete the version prefix |

- Enqueue `docs_preview_version` when a preview is replaced, and when a branch with a preview is erased.
- Enqueue `docs_orphan_version_prefix` before the materializer runs, with a grace period of 24 hours. If the publish transaction succeeds, the inspect step finds the row and keeps the prefix.
- Grace period for preview versions: 1 hour, which is the lifetime of the dispatcher host cache.
- The collectors build the prefix from the validated resource with `buildArtifactPrefix`. They never accept a key.

## 11. Module boundaries and clean-code rules

### 11.1 API layout

```text
apps/api/src/services/docs-branches/
  branch-service.ts        DocsBranchService: the public operations of section 8
  branch-resolver.ts       branchRef + actor + project → authorized branch context
  working-changes.ts       read and write rows, limits, hash and size
  effective-tree.ts        read one file or a file set: base prefix + rows
  sync-plan.ts             computeSyncPlan: pure, no I/O
  conflict-units.ts        classifyBranchPath, unit keys, structure grouping
  apply-resolutions.ts     plan + resolutions → row writes: pure
  validate-tree.ts         section 7.5 checks, returns ValidationIssue[]
  materialize.ts           shared artifact writer for publish and preview
  publish.ts               section 8.6 orchestration
  preview.ts               section 10.1 orchestration
  history.ts               list and restore
  errors.ts                typed 409 body builders
apps/api/src/repositories/
  docs-branches.ts         DocsBranchStore interface + Drizzle implementation
  docs-publications.ts     recordPublication, list, cursor
apps/api/src/routes/
  docs-branches.ts         thin HTTP shell, like routes/docs-content.ts
packages/contracts/src/
  docs-branches.ts         schemas and DTOs of this spec
```

- `DocsContentService` keeps page reads, the overview, and edits. It receives the branch context from `branch-resolver.ts` and uses `working-changes.ts` and `effective-tree.ts` for storage. Remove its R2 draft code.
- `DocsContentService` is 906 lines today. This work must not make it bigger. Move code out into the modules above.
- `sync-plan.ts`, `apply-resolutions.ts`, `conflict-units.ts`, and `validate-tree.ts` are pure. They take data and return data. They are the core of the correctness tests.
- Services receive their stores through constructor dependencies, as `DocsContentService` does today (`DocsContentServiceDeps`). A service never creates a database client or an R2 binding itself, except in its `fromEnv` factory.
- Define interfaces for the stores (`DocsBranchStore`, `DocsPublicationStore`). Tests use in-memory implementations. Do not mock Drizzle.

### 11.2 Types

- Derive DTO types from Zod schemas in `packages/contracts/src/docs-branches.ts`.
- Use discriminated unions for results and states: `SyncDecision`, `ConflictDto`, `BranchRef` after resolution (`{ kind: "hidden"; ... } | { kind: "named"; ... }`), and `PreviewChannelRecord`.
- Do not use `any`. Do not use `as` to silence the compiler. Do not use non-null assertions (`!`) on database results. Narrow with checks.
- Use branded string types for IDs that must not mix: `type BranchId = string & { readonly __brand: "BranchId" }`, and the same for `VersionId` and `SiteId`. Create them only in the resolver and the repository.

### 11.3 General rules

- One responsibility for each file. As a guide, split a file that goes past 300 lines, and review a function that goes past 40 lines.
- No duplicated logic. The publish and the preview share the materializer. The pull request and branch previews share the hostname helper. The synchronization and the publish share `validate-tree.ts`.
- Transactions live in the repository layer. A service calls a repository method that owns the transaction and the lock order of section 9.5.
- Comments explain why, not what. Match the style of the surrounding code, for example the comments in `docs-content.ts`.

### 11.4 Dashboard layout

```text
apps/web/src/components/dashboard/content/branches/
  branch-switcher.tsx             toolbar dropdown: main, named branches, actions
  branch-status-banner.tsx        "main changed" warning with Synchronize
  create-branch-dialog.tsx
  manage-branches-dialog.tsx      rename, erase, limit display
  sync-dialog.tsx                 conflicts, per-unit and bulk resolutions
  conflict-row.tsx
  conflict-diff-view.tsx          base / main / mine for one unit
  publish-dialog.tsx              summary + "Erase this branch" checkbox
  history-panel.tsx               publications + restore
  preview-button.tsx              build, open, outdated badge
apps/web/src/lib/queries/docs-branches.ts        query keys and queryOptions
apps/web/src/lib/dashboard/use-branch-context.ts selected branch, persisted per project
apps/web/src/lib/dashboard/use-branch-status.ts  polling and focus refetch
apps/web/src/lib/dashboard/use-sync-branch.ts
apps/web/src/lib/dashboard/use-publish-branch.ts
```

Follow the dashboard architecture rules in `AGENTS.md` and the visual language in `apps/web/DESIGN.md`.

## 12. Dashboard behavior

### 12.1 Branch switcher

- The content editor toolbar gets a branch switcher next to the site settings button from Spec 1. It shows `main` or the branch name, with a branch icon.
- The dropdown lists `main`, then the named branches sorted by the last update. Each item shows its number of changes.
- The actions are "New branch", "Manage branches", and "History".
- The selected branch is stored per project in `localStorage` (wrapped in `try`/`catch`). If the stored branch no longer exists, the editor falls back to `main`.
- A branch switch flushes the draft buffer first, as a page switch does today.

### 12.2 Main view

- The user edits in `main` with no branch concept. The page list shows "edited" badges for pages with changes.
- The toolbar shows "Unpublished changes" when the hidden branch has changes.
- "Discard all changes" discards the hidden branch after a confirmation.

### 12.3 "Main changed" warning

- `use-branch-status` polls `GET /branches/:branchRef/status` every 30 seconds while the editor is visible, and refetches on window focus. It stops while the tab is hidden.
- If `behind` is true, `branch-status-banner.tsx` shows a warning above the editor:
  "Main changed since this branch started: 2 new publications. The latest is a generation, 10 minutes ago. Synchronize to get the latest main."
- The banner has a "Synchronize" button. It opens the synchronization dialog.
- The banner uses the `--warning` token and `role="status"`.
- For the hidden branch, the same banner shows in the `main` view with the text: "Main changed while you edited. Synchronize to get the latest main."
- If any request returns 409 `branch_behind` or `main_changed`, the client refetches the status at once.

### 12.4 Synchronization dialog

- The dialog loads `GET /branches/:branchRef/sync`.
- With no conflicts, it shows the number of automatic updates and one "Synchronize" button.
- With conflicts, it lists each conflict unit with:
  - the unit name: the page title, "Site structure", or "Site settings",
  - what changed: for example "You edited · Main deleted",
  - a "Compare" link that opens `conflict-diff-view.tsx` with base, main, and mine,
  - a segmented control: "Keep mine" / "Keep main".
- Above the list, two bulk actions:
  - "Keep all main (fast sync)",
  - "Keep all mine (overwrite main changes)".
- "Synchronize" is disabled until every conflict has a resolution, or a bulk action is chosen.
- A 409 `main_changed` reloads the dialog and keeps the choices for units that still exist.
- A 422 shows the issues in the dialog, with the page title for `structure_missing_page`, and does not close the dialog.
- The "Site structure" item explains: "The navigation and the page list are resolved together."

### 12.5 Publish dialog

- The publish button opens the dialog. If the branch is behind, the dialog shows the warning and a "Synchronize first" button instead of "Publish".
- The dialog shows a summary: changed pages, structure changed, site settings changed.
- For a named branch, it shows a checkbox "Erase this branch after publish", on by default.
- For the hidden branch, there is no checkbox. The hidden branch is always erased.
- After a publish, the editor goes to `main` if the branch was erased, and shows a toast with the version number.

### 12.6 History panel

- A side panel lists the publications, newest first, with infinite scroll.
- Each entry shows the kind, the version number, the actor, the branch name, the page titles, and the time.
- The current entry has a "Live" badge (`--success` token).
- "Restore" opens a confirmation: "Restore version 12? The live site changes at once. Every branch will need a synchronization." A restore sends `expectedMainVersionId`.

### 12.7 Preview button

- "Preview" builds the preview and opens the URL in a new tab.
- When `preview.upToDate` is false, the button shows an "Outdated" badge, and a click builds again.
- The popover shows the URL, a copy button, and the exposure text from section 9.6.
- A 429 shows: "Wait a few seconds, then build the preview again."

### 12.8 Validation in the UI

- Use the Spec 1 issue store and `ApiValidationError` for every 422.
- The create and rename dialogs validate the name on change with the shared `branchNameSchema`, and show the error after blur. The API checks again, including `branch_name_taken`.
- At the limit, "New branch" is disabled with a tooltip: "This plan allows 10 branches. Erase a branch to create a new one." The limit comes from the entitlements in the overview.
- Every destructive action (erase, discard, restore, "Keep all mine", "Keep all main") has a confirmation that names the consequence.

### 12.9 Site settings dialog (Spec 1)

The site settings dialog saves to the selected branch. Its `set_site_config` call sends the `branch` field. The rest of the dialog does not change.

## 13. Migration and removal of drafts

Doxa has no customers, so the existing drafts are discarded.

1. The migration creates the new tables, enums, columns, and checks.
2. The migration backfills one publication for each site with a head: `kind: "import"`, `version_id = published_version_id`, `previous_version_id = null`, `summary = {}`.
3. Remove the R2 draft code:
   - from `packages/docs-engine/src/index.ts`: `DEFAULT_DRAFT_ID`, `docsDraftMetaSchema`, `DocsDraftMeta`, `buildDraftPrefix`, `draftMetaPathForPrefix`, `draftSourcePathForPrefix`,
   - from `DocsContentService`: every draft read and write,
   - `DELETE /draft` and `POST /publish` in `routes/docs-content.ts`, which the branch routes replace,
   - `docsContentDraftSchema` and `publishDocsContentInputSchema` in the contracts.
4. Add `apps/api/scripts/erase-legacy-drafts.ts`. It lists `sites/*/drafts/` and deletes the objects. It has a `--dry-run` mode, which is the default. Ask the user before you run it against a real bucket.
5. Keep `contentVersionStatePrefix` and the rule that a manual version is never a generation baseline. Branch publishes use it too.

## 14. Documentation

- Rewrite `docs/docs-content-editor.md`: the model, the publish, the code map, and the HTTP surface. Remove the "Multiple drafts" seam, which this spec implements.
- Add `docs/current/docs-branching.md`: a reference for branches, synchronization, conflicts, the publication history, previews, limits, and the lock order.
- Add the two collectors to `docs/current/storage-garbage-collection.md`.

## 15. Implementation order

**Prerequisite:** Spec 1 phases 1 to 4 are merged. Spec 1 phase 5 (the dashboard dialog) can be merged before or during phase B6.

| Phase | Work | Needs |
|---|---|---|
| B1 | Contracts (`docs-branches.ts`, path schema, name schema, DTOs, issue codes, shared message table), entitlements field, database schema and migration file (not run without approval), repositories with in-memory test doubles. | Spec 1 phases 1–4 |
| B2 | Storage switch: `branch-resolver`, `working-changes`, `effective-tree`, and `DocsContentService` on branches. The `main` view works through the hidden branch. `set_site_config` writes a row. Removal of the R2 draft code. | B1 |
| B3 | Synchronization, conflicts, publish, materializer extraction, publication history in all three writers, history list, and restore. | B2 |
| B4 | Named branches: create, fork, rename, erase, and the limit. | B3 |
| B5 | Branch previews: channel changes, hostname helper, preview build, resolution, access policy, and the two GC collectors. | B4 |
| B6 | Dashboard: switcher, status polling and banner, synchronization dialog, publish dialog, history panel, preview button, branch dialogs, and the site settings dialog on branches. | B5 (API complete) |
| B7 | Documentation (section 14) and the legacy draft script. | B6 |

Each phase is one reviewable change. Stop and report after each phase.

## 16. Verification

### 16.1 Pure core (unit tests, table-driven)

- `computeSyncPlan`: every row of the decision table in section 7.2, with modifications, deletions, additions on one side, and additions on both sides with equal and different content.
- Structure unit: a change to one structure file on each side gives `conflict`, and a change to the same file with equal content gives `drop_change`.
- `applyResolutions`: `mine` for the structure unit writes rows for every structure path, `main` deletes them, and the bulk defaults apply only to units with no explicit resolution.
- `validateTree`: a missing page gives `structure_missing_page`, an orphan gives `orphan_page`, and a valid tree gives no issue.
- `branchPathSchema`: accepts every allowed path. Rejects `../`, `source/../manifest.json`, `source/Foo/index.mdx`, `source/a//index.mdx`, `search/index.json`, `settings/other.json`, `%2e%2e`, a backslash, and a leading `/`.
- `branchNameSchema`: the boundaries (1 and 40 characters), hyphen rules, uppercase, reserved names.
- Hostname helper: the pull request output is identical to the current function for a table of inputs. Branch labels are 63 characters or less and end with the random suffix.

### 16.2 Service tests (in-memory stores)

- First edit in `main` creates one hidden branch, even with two parallel calls.
- An edit that restores base content deletes the row.
- Fork copies every row and the base.
- The limit: the 11th named branch fails with `branch_limit_reached`, and two parallel creations at 9 branches give 10 branches, not 11.
- Publish when behind gives 409 `branch_behind`. Publish when up to date writes a version, moves `main`, records a publication, and erases or resets the branch according to `eraseBranch`.
- A generation publish during an open branch makes the branch behind. After synchronization, the publish succeeds and contains the changes from both.
- Restore moves `main`, records `kind: "restore"`, and rejects a publication of another site.
- A publish, a restore, a generation publish, and a promotion each create exactly one publication row.
- An edit after an erasing publish returns `branch_not_found`.

### 16.3 Authorization tests (HTTP)

- Every branch route returns 404 for a branch of another user's project, and for a branch ID of another site in the same project owner's account.
- The erase, publish, and restore routes reject the `agent` and `mcp` origins.
- No response contains an artifact prefix or an R2 key.

### 16.4 Database tests

Run these against the local database (`pnpm db:local:up`, `pnpm db:local:migrate`):

- The check constraints reject a named branch without a name, a hidden branch with a name, a delete row with content, and a branch preview channel with a provider.
- The partial unique indexes reject a second hidden branch for the same user and site, and a duplicate name in one site.
- Erasing a branch cascades to its rows and its preview channel.

### 16.5 Preview tests

- A build creates a preview version and a channel. A second build moves the channel and enqueues the GC of the first version.
- `resolveByHostname` for a branch channel returns the preview version with the generation preview access policy.
- The GC collector keeps a version that is a branch base, a channel head, or the site head.

### 16.6 Dashboard tests

- The banner appears when `behind` is true, and "Synchronize" opens the dialog.
- The synchronization dialog: the button stays disabled until every conflict has a resolution; the bulk actions set every unit; a 409 reloads and keeps the valid choices.
- The publish dialog: the checkbox is on by default for a named branch, and absent for `main`.
- The switcher falls back to `main` when the stored branch no longer exists.
- Keyboard-only use reaches every control in the dialogs, and the focus returns to the trigger when a dialog closes.

### 16.7 Commands

```bash
pnpm --filter @doxahq/contracts test
pnpm --filter @doxahq/db typecheck
pnpm --filter @doxahq/api test
pnpm --filter @doxahq/web typecheck
pnpm --filter @doxahq/web build
```

This spec does not change the renderer or the artifacts. If a phase touches `packages/docs-engine`, also run the three compatibility suites from `AGENTS.md`.

## 17. Decision record

Decisions from the user on 2026-09-23 and 2026-09-24:

1. Storage uses Git's model on Postgres and R2. There is no Git server.
2. A commit happens only on publish. Autosave writes working changes only.
3. Every publish is a squash merge into `main`.
4. Edits in `main` go to a hidden branch, one for each user and site. The UI never shows it. It is erased, not archived, after publish.
5. After a named branch publish, the user chooses to erase the branch with a checkbox that is on by default.
6. When `main` changes, the dashboard warns the user and asks for a synchronization with the latest `main`.
7. Conflict resolution is "keep mine" or "keep main", for each file or for the whole branch.
8. Each branch has a preview URL, with the same access policy as generation previews.
9. The limit is 10 named branches for each site, through the entitlements, so that a plan can change it. There is no expiry.
10. The existing drafts are discarded, with no migration.

Design refinements in this spec, from the implementation research on 2026-09-24:

- A version is the commit. There is no separate commit table and no content-addressed object store in this version (section 3).
- Working changes live in Postgres, not R2 (section 3).
- The site structure is one conflict unit (section 6.2).

## 18. Follow-ups outside this spec

- Line-level automatic merge for MDX (diff3).
- Key-level merge for `settings/site.json` and the navigation files.
- Content-addressed page bodies in a later artifact schema, to reduce the publish copy.
- Branch expiry, and the plan-specific limit values when billing exists.
- Team members, and branch ownership by member.
- Private previews: the signed token exchange and the preview gate.
