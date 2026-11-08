# Generation Reviews

**Status:** Implemented (phases 1 to 5)

**Last reviewed:** 2026-10-11

## Purpose

A production generation can replace pages that a person wrote or approved.
A generation review holds the output of the generation until a person
decides on each page and publishes the result. The live site does not change
before that publish.

This document describes when a review opens, how it stores its pages, how a
person decides, and what the published version keeps for the next run.

## When a Run Goes to Review

The API decides when the worker completes a production run
(`DocsRepository.completeJob`).

| Published site | Result |
| --- | --- |
| No published version | The run publishes directly. |
| Only starter publications | The run publishes directly. |
| Any other publication | The run writes a staged version and opens a review. |

A staged version uses `channel: "preview"` and `status: "staged"`. It takes a
number from the preview sequence, so the published sequence has no gaps. The
generation job points to it, so storage collection keeps it.

The job event for a staged run is `staged_for_review`. The review service adds
`review_ready` when it opens the review, or `review_skipped` when the run
changed no page.

## Warning Before the First Generation

If the site has an `editor` or `import` publication and no compatible
generation baseline, admission returns `confirmation_required` with the
reason `editor_content`. The dashboard shows a dialog that explains the
review and the backup branch. The confirmation uses the same `force=true`
request as the `unchanged_source` confirmation. The two reasons never apply
to the same start, because a site without a baseline cannot be unchanged.

## Offer Before the First Generation

The dashboard offers the instructions page before a project's first generation.
The offer shows when the project has no generations and no saved instructions,
and the person can change instructions (`instructions.configure`). The check is
in `apps/web/src/lib/dashboard/instructions-offer.ts`. If the check fails, the
generation starts.

- Project pages use `useGenerationStartFlow`. A re-run does not use it, because
  a re-run always has an earlier generation.
- The repository dialog on `/dashboard/projects/new` shows the offer before it
  creates the project.
- "Add instructions" opens `/doxabot/instructions?then=generate`. Only this
  value shows "Save and start generation".

The API does not know about the offer, so an MCP agent starts as before.

## Warning When Nothing Changed

Admission returns `confirmation_required` with the reason `unchanged_source`
only when all of these values match the published version:

- The source tree hash.
- The generator fingerprint.
- The Doxabot instructions fingerprint.

The instructions fingerprint of the published version comes from the
generation state that the version names. The run planner reads the same value,
so a start that skips the warning also plans the instruction edits. If admission
cannot read that state, it keeps the warning.

## Storage Model

A review is a named branch with `purpose = 'generation_review'`, plus one
`generation_reviews` row and one `generation_review_pages` row for each page.

- The branch base is the published version when the review opened.
- The branch changes are the difference between that version and the staged
  version, after the page decisions.
- A site has at most one open review (`generation_reviews_site_open_idx`).
- Review and backup branches do not count toward the branch limit of the plan.

The review carries these files:

- Page sources (`source/**/index.mdx`)
- Structure files (`manifest.json`, `settings/sections.json`,
  `settings/documents*.json`)
- Site settings (`settings/site.json`), because they hold the runtime features
  that the generation detected

The branch publish rebuilds the search index and the manifest metadata.

## Page Changes and Decisions

The review compares the two versions by page href.

| Change | Initial decision | Accepted | Rejected |
| --- | --- | --- | --- |
| `added` | `accepted` | The page is added. | The page is not added. |
| `modified` | `accepted` | The generated body goes live. | The published body and title stay. |
| `removed` | `accepted` | The page is removed. | The published page stays in its section and group. |

Every page starts with the change that the generation made, a page that a
person locked included. A person who trusts the run publishes the review as it
is. A person who does not reviews it. A taken-back decision (`undecided`)
returns the page to the generation's change. A new review never stores
`pending`. An older review can hold `pending` for a removal: the review
branch keeps that page, and the publish keeps it too.

A decision edits the review branch as it is now
(`applyDecisionsToBranch`). It changes only the decided page, so every other
edit on the branch stays, structure edits included:

- A decision that keeps the page updates its title and body, unless a person
  edited the body. A person's edit of a page body or of the site settings has
  `origin: "editor"`, and later decisions and later runs keep it.
- A decision that takes the page off the branch removes it, with any edit.
- A decision that brings a page back restores it at its own href, where the
  generated or the published site has it. When another page uses that href
  now, the decision fails with `conflict`.
- A restored page goes between the same neighbors in its group that it has
  in that site, and a restored heading goes between the same headings
  (`restoreStructurePage`). Rejecting a whole group and accepting it again
  therefore gives back the generated order. Before 2026-10-17, a restored
  page went to the end of its group, so this sorted a group by route.

## Renamed and Moved Pages

A person can rename a review page, or move it to another section, on the
review branch. The review still names the page by the href that the
generation gave it (`generation_review_pages.href`), and it stores where the
page is now in `branch_href` (null while the page is at its own href).

- The branch write that renames or moves the page updates `branch_href` in the
  same transaction (`followReviewPageMoves`). The editor reports each moved
  page once per save, from its first href to its last.
- Decisions act on the page at `branch_href`. A decision that takes the page
  off the branch, or brings it back, resets `branch_href`.
- The diff compares the published and the generated page at `href`.
- The API returns `branchHref` on each review page. The editor opens, marks
  and steps through the pages by `branchHref`.

## A Newer Run with an Open Review

A newer production run moves the open review to itself:

1. The review compares the current published version with the new staged
   version.
2. A decision carries over when the page has the same change kind.
3. Agent changes of the earlier run that the newer run does not make reset
   to the published version.
4. A person's edits stay.
5. A renamed or moved review page stays where the person put it, while the
   newer run keeps the page and its branch href is free (`placeMovedPages`).
   Otherwise the page goes back to its own href, and the moved copy goes.
6. The branch base moves to the current published version.

The newer run rebuilds the navigation from its own structure, so a person's
structure edit on a page outside the review does not carry over.

A review that keeps a backup keeps that promise after the move.

## Publishing

The dashboard calls `POST /projects/:projectId/generation-review/publish`.
The service uses the branch publish flow with `eraseBranch: true`.

The publication transaction does these steps:

1. It locks the open review of the branch.
2. It copies `sourceRevision`, `sourceTreeHash`, `generatorFingerprint`, and
   `generationStatePrefix` from the staged version to the new version.
3. It records a `generation` publication.
4. If the review replaces hand-written content, it creates a branch with
   `purpose = 'generation_backup'` named `backup-YYYY-MM-DD`. The branch base
   is the previous published version.
5. It marks the review `published`.

## The Next Run

The published version names the generation state of the staged version, for
example `sites/{site}/generation-state/{stagedVersionId}`.
`generationStateOwnerVersionId` in `@doxahq/docs-engine` reads the owner. The
production baseline check and the worker accept any state of the same site.

The worker reads each reused page from the published version at its route.
If a person rejected a rewrite, the published body differs from the state,
and the published body wins. If the published version has no page at that
route, the worker reads the artifact of the state and checks its hash.

## The Run Starts From the Live Site

People change the live site between runs. They rename, move, delete, and add
pages, and they change the navigation. A run must not undo these changes.
The worker therefore syncs the stored state with the live version each time
that it loads the state (`syncReusableStateWithLive` in
`apps/agent-worker/src/live-state-sync.ts`). Every step loads the same live
version, so every step and the container see the same state.

- The stored state gives what a run needs to write a page again: its
  brief, evidence, reference data, and dependencies. The live site gives
  each page its route and file.
- Pages match by route, then by an identical body, then by title in the
  same section (`matchPages` in `@doxahq/docs-engine`). Only pages whose
  route the other side lacks are read.
- A page that a person deleted leaves the state. A page that a person
  created joins the state from its live file, with no evidence, so no run
  rewrites it.
- A title, a section label, a navigation group, the navigation visibility,
  and the page order follow the live site only where a person changed
  them. The worker compares the live version with the version that the
  state was written with. The generation derives some of these values when
  it publishes (navigation headings for reference pages, navigation labels,
  the order), so the live value alone does not show what a person set.
- If the files of that version are gone, titles and section labels compare
  with the stored state, and groups, visibility, and order keep their
  stored values.
- A rename or a move keeps the page ID. The page input hash follows the
  synced structure, so the page is not written again. A stored hash that
  the stored structure did not explain stays, and the page is written
  again.
- A moved page points at its live file. A page that no navigation lists
  stays in its section.
- A live section takes the ID of the stored section with the same folder.
- A live page that cannot be read stops the run.
- If nothing changed, the run gets the stored state as it is.

The worker uses `@doxahq/agent/structure`, the Worker-safe entry of the
agent. It hashes page inputs with Web Crypto, and the agent tests confirm
that these hashes equal the hashes of the generation service.

## Page Locks

A person can lock a page so that generations keep it as published. Every
page starts unlocked: a generation can update it when its code or evidence
changes, also after a person edited it. Editing a page does not lock it.

A person locks a page with **Lock from generations**, in the Agent section
of **Page settings**. Page settings opens from the menu of the page in the
content sidebar. The dialog says that a person always reviews a
generation's changes before they go live. A locked page shows a `BotOff`
mark in the sidebar and an "Agent locked" tag in the editor. Both explain
the lock in a tooltip.

Locks are rows of `docs_page_ownership` by site and href, with the state
`owned`. Unlocking deletes the row. Rows with the state `released` are
ignored. Rows that the earlier automatic ownership made stay locked until a
person unlocks them.

A publication changes locks only to follow pages (`followPublishedPages`).
If the publication moves a locked page, the lock moves to the new route. If
it removes a locked page, the lock goes. A publication looks for moves only
when it deletes a page file (`publishedPageChanges`).

### In the Run

The API adds the locked hrefs to the execution context (`pageLocks`). The
worker applies them to the plan before it stores the structure checkpoint
(`applyPageLocks`):

- A locked page that the plan would rewrite is reused from the published
  version. Its rewrite causes and edits are dropped. If a source file that
  the page read changed, the plan flags the page with the changed paths.
- A page needs a baseline state to be reused, so a locked page without one
  is left in the plan. The review shows the rewrite with the reason
  `owned_by_person`.

The completion sends the flags to the API, and the review shows them as
"Locked pages, code changed", with an **Unlock** action. A run that only
flags pages opens a review with no page changes, which the person dismisses.

In the review, a modified or removed page that is locked starts `accepted`,
like every page, with the reason `owned_by_person`.

## Editor Publications Keep the Baseline

An editor publication copies `sourceRevision`, `sourceTreeHash`,
`generatorFingerprint`, and `generationStatePrefix` from the version that it
was based on, if that version has generation state. The next run then stays
incremental, and the run starts from the edited pages (see "The Run
Starts From the Live Site"). A base without
generation state gives the `content-versions/` prefix, as before.

## Other Rules

- Promote returns `review_required` for a production run whose version is
  staged. The review is the only way to publish it.
- Erasing the review branch from the branch menu discards the review.
- `POST .../discard` erases the branch and marks the review `discarded`.

## Ready for Custom Instructions

Custom instructions are not implemented. These parts keep them easy to add:

- `resolveRunBrief` in `apps/agent-container/src/run-brief.ts` is the only
  place where a run gets its documentation brief. Instructions enter there.
- Each page state records `briefFingerprint`, the brief that the page was
  written with. A reused page keeps its earlier value. A change of
  instructions can then find the pages written with older ones.
- Review reasons are a union on `kind`. New kinds, such as
  `instructions_changed`, are additions.
- Production runs carry a `trigger` (`manual` or `merge`), so a run
  instruction is one more field of the start request.
- The Doxabot settings update is partial, so an `instructions` field does
  not break older clients.
- A lock applies to every rewrite cause, so an instruction change never
  rewrites a locked page.

## Lock Order

Review transactions follow the branch lock order, with the review row last:

1. `docs_sites`
2. `docs_branches`
3. `generation_reviews`

## Routes

All routes are under `/projects/:projectId/generation-review`.

| Route | Capability | Result |
| --- | --- | --- |
| `GET /` | `docs.read` | The open review, or `null` |
| `GET /page?href=` | `docs.read` | The published and generated source of one page |
| `POST /decisions` | `docs.write` | The updated review |
| `POST /publish` | `docs.publish` | The new version and the backup branch name |
| `POST /discard` | `docs.write` | `{ discarded: true }` |

## Pull Request Preview Changes

A pull request preview run opens no review. Its generation page offers
**View changes**, which opens
`/dashboard/projects/:projectId/generations/:generationId/changes`: the
changed pages in the layout of the content review, read-only. Nobody decides
there. When the pull request merges, a production run goes to a review, and
that review publishes the changes.

- The pages compare the run's version with the version that it was built on
  (`docs_versions.baseline_version_id`), else with the live version, whichever
  still has its files (`GenerationChangesService`).
- The list, the diff, the rendered page and the J and K steps are the review
  components with `readOnly`. A changed page is shown as a review page that
  nobody decided on (`toChangesViewPages`).
- Only a succeeded preview run with a version shows its changes. A production
  run answers `invalid`, and a run without readable files answers `not_found`.

| Route | Capability | Result |
| --- | --- | --- |
| `GET /projects/:projectId/generations/:generationId/changes` | `generation.read` | `{ changes }` |
| `GET /projects/:projectId/generations/:generationId/changes/page?href=` | `generation.read` | The base and generated source of one page |

## Pull Request Preview Lifecycle

`DoxabotWebhookOrchestrator` handles pull request events. GitHub's `edited`
event counts only when the base changed; it is normalized as `base_changed`.

- **Stop.** A pull request that closes, merges, or moves off the production
  branch stops its previews (`stopPreviews`). Its queued or running preview is
  cancelled, and its preview channel closes (`PreviewChannelClosureRepository`):
  the channel keeps no version, its hostname stops resolving and is purged,
  and the version is retired as `preview_closed`, so retention collects it
  after the promote window. A reopened pull request takes the channel back
  with its next preview. Each step runs even when another one fails.
- **Side paths.** When Doxabot is off or unavailable, or the base is not the
  production branch, only a pull request that Doxa recorded is handled. The
  event goes through the record's staleness checks first, so a late `closed`
  event never stops a reopened pull request. A push while Doxabot is off
  cancels the run on the old head as superseded and keeps the last preview.
- **Admission.** The webhook and a re-run admit a preview in one transaction
  that locks the pull request record (`checkPreviewAdmission`). The caller
  passes the record as it saw it. If the record changed since, and now says
  closed, merged, another base, or a newer head, the admission answers
  `stale_change` and no job starts. Every record write waits for the lock, so
  a close lands either before the admission and refuses it, or after it and
  cancels the new job. A newer head cancels the active run inside the same
  transaction, so a late older push never cancels the run of a newer one.
- **Cancel.** Every cancel (a newer push, an ended pull request, a person, an
  agent, a paused worker) closes the GitHub check: `cancelGenerationJob`,
  `finishGenerationCancellation` after an admission, or `markJobCancelled` on
  the internal API. The cancel event keeps the check text in `data.check`.
  `ReviewRunsService` keeps a check in agreement with its job
  (`checkAgreesWithJob`): an ended job takes only its own conclusion, and a
  contradicting update returns `skipped`. A check that was created during a
  cancel is closed by its creator, with the stored text ("stopped",
  "superseded") when there is one.
- **Cache clear.** A cleared generation cache keeps previews on
  (`hasPublishedVersion`). The next preview has no baseline and analyzes from
  scratch; the worker accepts a preview without one.
- **Re-run and resume.** A re-run reads the pull request from GitHub and
  refuses `change_not_open`, `base_not_production`, or `superseded` (GitHub has
  a head that Doxa has not recorded). A change that Doxa records during the
  re-run gives the same answers, from `stale_change`. Resume and the page
  buttons use the record with the same rules.

## Page Lock Routes

All routes are under `/projects/:projectId/page-locks`.

| Route | Capability | Result |
| --- | --- | --- |
| `GET /` | `docs.read` | `{ pages: [{ href }] }`, the locked pages |
| `PUT /` | `docs.write` | Body `{ href, locked }`. Locks or unlocks one page |

## Seed Mode

The warning dialog of a first generation over hand-written content offers
two choices. "Use my pages as a guide" is the default. The dashboard sends
`seed=true` with the confirmed start, and admission records the published
version in `generation_jobs.seed_version_id`. Admission ignores `seed` when
the site has a generation baseline or no hand-written publication.

A seeded run works like this:

1. The API adds `seedVersion` to the execution context.
2. The worker reads that version (`loadSeedSite`): the sections, the
   navigation with its group headings, the page titles and frontmatter
   descriptions, and the page bodies by route. It sends the navigation as
   `seedSite` with every stage request, and the bodies as `seedBodies` with
   each write request.
3. The container turns `seedSite` into a `DocumentationStructure`
   (`seedStructureFromSite`). Each page keeps its href as `canonicalRoute`.
   Without a generation baseline, this structure is the planner's anchor.
4. Each writer gets only the body of its own page (`seedTextForPages`). The
   prompt tells it to keep what the source confirms, to follow the source
   where they disagree, and to list each disagreement in a trailing
   `{/* doxa-seed-conflicts ... */}` comment.
5. The review reads the conflicts (`extractSeedConflicts`), shows them as
   the reason `seed_conflicts`, and strips the comment before the page goes
   to the branch.
6. A hand-written page that the generation left out starts `accepted`, like
   any removal, so the publish deletes it. The person restores it to keep it.
   Older reviews can show the reason `seed_page_kept`: there the page
   started `rejected`.

## Source Citations

The worker sends the source files behind each page that it wrote
(`pageSources`: the files the writer read, then the evidence files, at most
12). The review shows them as the reason `based_on_sources`.

## Production Branch

Each project has a production branch (`projects.production_branch`). Production
runs read it, merges into it feed the merge trigger, pull requests must target
it for a preview, and `.doxa/instructions.md` is read from it. Null follows the
repository's default branch on GitHub, so projects made before the column keep
their behavior. SQL reads it through `productionBranchSql()`
(`apps/api/src/repositories/production-branch.ts`).

- A new project (`POST /projects`) and a repository connect
  (`PUT /projects/:projectId/repository`) take an optional `productionBranch`.
  The dashboard asks for it and starts on the default branch. A connect always
  replaces the branch of an earlier repository.
- `PUT /projects/:projectId/doxabot` with `{ productionBranch }` changes it.
  The settings DTO returns `productionBranch` and `repositoryDefaultBranch`.
- Before the API stores a branch other than the default branch, it asks GitHub
  that the branch exists (`RepositoryBranchesService.exists`). A missing branch
  answers 422 `branch_not_found`. A GitHub failure answers 502
  `branch_check_unavailable`.
- The pickers list branches with `GET /github/repos/:repositoryId/branches`
  (new project, the user's own installation) and
  `GET /projects/:projectId/doxabot/branches` (`generation.run`). Each answers
  `{ defaultBranch, branches, complete }`, with at most 1,000 branches.
- A change does not touch the live site. The next production run reads the
  new branch and compares it with the published version.

## Merge Triggers

Doxabot settings choose what a pull request merged into the production branch
starts (`doxabot_automation_settings.merge_trigger`). The merge trigger does not
depend on the pull request previews setting (`enabled`): a merge feeds it also
while previews are off. It needs Doxabot to be available for the project (a
connected private repository and a first publish). The dashboard shows it as
its own card, "When a pull request merges".

| Value | Result |
| --- | --- |
| `manual` | The merge is listed on the project overview. A person starts the update. |
| `batched` (default) | One run starts when no pull request merged for `batch_quiet_minutes` (15, 30, 60, or 360; default 30). |
| `every_merge` | A run starts after each merge. |

Every run goes to a review, so no trigger changes the live site by itself.
The settings update is partial: a client sends only the fields it changes.

The flow:

1. The GitHub webhook records each merged pull request in
   `generation_pending_merges`, while Doxabot is enabled. With
   `every_merge`, it also starts a run at once.
2. The 5-minute API cron (`MergeGenerationScheduler.run`) starts a run, with
   the job trigger `merge`, for each project whose untried merges are due.
3. A start that meets an active run tries again on the next tick. Any other
   answer marks the merges as tried, so a start that needs a person (for
   example the first run over hand-written pages) waits for a newer merge.
4. A production run that completes removes the merges before its start.

A `merge` run uses the revision-aware production pipeline, like a manual
run. Its author shows as Doxabot. Direct pushes to the production branch are
not recorded.

| Route | Capability | Result |
| --- | --- | --- |
| `GET /projects/:projectId/doxabot/pending-merges` | `project.read` | `{ merges: [{ number, mergedAt }] }` |

## Related Files

- [`packages/contracts/src/generation-reviews.ts`](../../packages/contracts/src/generation-reviews.ts)
- [`apps/api/src/services/generation-reviews/`](../../apps/api/src/services/generation-reviews/)
- [`apps/api/src/repositories/generation-reviews.ts`](../../apps/api/src/repositories/generation-reviews.ts)
- [`apps/api/src/repositories/generation-review-publication.ts`](../../apps/api/src/repositories/generation-review-publication.ts)
- [`apps/api/src/repositories/page-locks.ts`](../../apps/api/src/repositories/page-locks.ts)
- [`apps/api/src/services/docs-branches/page-moves.ts`](../../apps/api/src/services/docs-branches/page-moves.ts)
- [`apps/agent-worker/src/page-locks.ts`](../../apps/agent-worker/src/page-locks.ts)
- [`apps/agent-worker/src/live-state-sync.ts`](../../apps/agent-worker/src/live-state-sync.ts)
- [`packages/docs-engine/src/page-matching.ts`](../../packages/docs-engine/src/page-matching.ts)
- [`packages/agent/src/structure.ts`](../../packages/agent/src/structure.ts)
- [`apps/agent-worker/src/seed-site.ts`](../../apps/agent-worker/src/seed-site.ts)
- [`packages/agent/src/doxa-agent/seed-structure.ts`](../../packages/agent/src/doxa-agent/seed-structure.ts)
- [`apps/api/src/services/doxabot/merge-generations.ts`](../../apps/api/src/services/doxabot/merge-generations.ts)
- [`apps/api/src/repositories/pending-merges.ts`](../../apps/api/src/repositories/pending-merges.ts)
- [`apps/web/src/components/dashboard/review/`](../../apps/web/src/components/dashboard/review/)
