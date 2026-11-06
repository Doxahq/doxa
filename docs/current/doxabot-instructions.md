# Doxabot Instructions in a Generation

A project owner saves instructions on the Doxabot page. A generation follows
them from the first read of the code to the last page. This document says where
each instruction takes effect, and what code enforces without a model.

## The Rule

Every model call of a run reads the instructions:

- Exploration, analysis, and incremental analysis.
- Structure, structure review, and ordering.
- The writer, section repair, and MDX repair.

Each call reads the same block, and then the lines that say what the
instructions mean for its step (`project-instructions/stage-guidance.ts`). Where
another rule of a prompt names a page type or a reader that the instructions rule
out, the instructions win. The guidance lines repeat no owner text, so they add
no way to steer a model.

A prompt line can be missed, so code also applies each instruction that it can
check. Add a new model call only with the block. Add a new instruction with its
enforcement in the table below.

## What Enforces Each Instruction

| Instruction | Analysis (`applyProjectInstructions`) | Plan (`applyProjectInstructionsToPlan`) | Finished page (`checkPageInstructions`) |
| --- | --- | --- | --- |
| Readers | Sets `documentationIntent.audience` and `intendedReaders`. | | |
| Tone and address | Sets `preferredTone`. | | Prompt only. |
| Terminology | Sets the preferred terms and removes the avoided terms. | | Reports an avoided term. |
| Code languages | | | Reports a `<Tabs>` group with another order or language. |
| Page types | With the API reference off, no spec is read and no reference surface stays. A collection item whose title names a type that is off, and no type that is on, is removed. | Removes a page of a type that is off. | Reports a troubleshooting or FAQ section when troubleshooting is off. Other page types inside a page are prompt only. |
| Do not document | Removes the paths from every list that later steps read, including collection, reference and workflow evidence. | Removes a page that has only excluded evidence, and removes excluded evidence from other pages. After code adds collection and reference pages, it removes excluded evidence again. | Reports an excluded path in prose, inline code, and imports. |
| Rules and context | | Prompt only. | Prompt only. |

### Page Types in the Plan

When a page type is off, the planner declares `pageType` on every page, and a
declared type decides alone. A page without one sends the plan back to the
planner while attempts remain. Reference pages and collection item pages are
exempt: a reference page is judged by its reference.

On the last attempt, the title decides (`utils/planned-page-types.ts`). A title
removes a page only when it names a type that is off and no type that is on. Nav
headings use the same rule. A title never removes the landing page, which is the
first page of the Documentation section. The site needs that page, so a landing
page titled "FAQ" stays even with troubleshooting off, and the writer guidance
keeps its content within the instructions.

Items removed from a collection because their type is off still count toward its
minimum of 4 items, so the other items keep their pages.

### The Plan Filter

The plan step runs on the model's answer, before code adds collection and
reference pages. What it removes counts as the model's plan. When the filter
removed pages and the plan then fails validation because of those removals, the
plan goes back to the planner with a note that names the removed pages
(`PlanNeedsRevisionError`). An error that the removals do not explain stays a
defect of the code that adds pages (`StructurePipelineDefectError`). The run log names each removed page
with the event `structure_pages_removed_by_instructions`.

### Finished Pages

A finished page that breaks an instruction gets a soft issue. The writer gets
another attempt with the reason, and `validate_page` reports the same issue. After
the last attempt the page stays: a regular expression cannot tell a product name
from a term that the owner avoids, so a page never fails or drops because of a
word.

When a later attempt stops at the token limit, runs out of its agent loop, or
fails an MDX repair, an earlier page is kept only when all its remaining issues
are instruction issues. Any other soft issue, such as a page cut off in the middle
of a sentence, sends the page to its page-level retry. A kept page ships as the
writer wrote it. Code never edits its text, because such fixes can delete facts
or code (`Python 3.10` became `Python 3.` in a probe).

A page that the writer keeps with open issues sends the job event
`generation_page_notice`. The run log shows it as a writer warning, and the review
lists the page under "Check these pages" with its issues. A notice holds the page
title (one line, at most 200 characters) and at most 10 short issue messages
(`pageOpenIssueSchema`), never the page text. The step that records flagged pages
collects the notices, before it records anything, and stores them next to the
run's checkpoints (`<scope>-page-notices.json`). Its step result keeps only their
key. The notices are sent in their own step that runs once, without retries. A
failed notice is logged and skipped, so it never fails a run.

A page that an MDX repair fixed keeps the repaired text as validated, and goes
through the instruction checks before it is accepted. The section-repair gate
compares each break, for example one more use of an avoided term or a new
excluded path. It rejects a splice with any break that the original page did not
have. Code language breaks compare by count: a splice that only changes the
languages of an out-of-order `<Tabs>` group passes, and one that adds a group
that breaks the order is rejected. Section repair never runs on REST endpoint
pages.

Open issues are found again on the page as it ships, after the title, cleanup and
formatting, and before the REST block.

The checks skip lines longer than 8,000 characters and path tokens longer than
512 characters, so a long line cannot slow a run. A term pair that differs only
in case, such as "GitHub" and "Github", is matched with its case. The excluded
path check reads prose, inline code, imports (including Python and Rust), and
path arguments in shell and cURL code blocks, including mount sources such as
`-v internal/data:/data`. A module path also counts as its folder, so
`import internal` matches `internal/**`. It ignores HTTP routes and URLs. Import
items longer than 320 characters, module paths over 160 characters, and Rust
group members after 8,000 characters of expanded paths are not checked.

REST request samples follow the owner's code language order. Code renders the
REST reference block from the API spec, so the page checks skip it.

## Do Not Document Paths

A path is a glob from the repository root: `*`, `?`, `**`, and `{a,b}`. The save
schema refuses a leading `/` or `./`, `..`, character classes such as `[ab]`, and
more than 256 brace alternatives. A saved version from before these rules is read
with `storedDoxabotInstructionsSchema`, which strips `./` and leaves out globs that
no matcher supports. Every step uses one matcher (`excludedPathMatcher`). It skips
a glob that cannot compile, with a warning, so one glob cannot stop a run.

## The Internal Team as the Reader

The reader is the only instruction that changes the documentation policy
(`resolveDocumentationPolicy`). With the internal team as the reader, architecture
and team workflows are in scope, and the pipeline writes for maintainers. Secrets
stay out, and the file access rules do not change. The value comes from a fixed
list in the instructions. Owner text and repository text cannot select it.

The prompt lines that keep tests and contributor material out of public docs
depend on the reader (`prompts/dynamic/readers.ts`). For the internal team, the
analysis prompt asks only for generated, vendored, and repository-only paths in
`internalOnlyPaths`, so tests can be evidence, and `dist/` or `vendor/` cannot.
The owner's "Do not document" paths stay out for every reader, and the file
access rules still block secrets such as `.env`.

Required REST and SDK pages stay mandatory, whatever their title says. Only a
collection page can lose its mandatory mark because its title names a type that
is off. Nav headings that name a type that is off, from the ordering model or
from a collection title, take the section label instead. No page is dropped.

## A Version per Run

The API attaches the instructions when the worker loads the generation context,
and every stage of the run uses that copy. A save during a run takes effect in
the next run. "Continue run" keeps the copy of the run. The worker records the
version once per run, in its own step, with the event
`project_instructions_applied`.

With the repository file on, only the file or a 404 counts as an answer from
GitHub. A 408, a 429, a 5xx, a network error, or a failed body read gets 3
attempts, each with a 20-second limit. A 403 is retried as a rate limit when its
headers (`retry-after`, `x-ratelimit-remaining: 0`) or the start of its message
say so. A 401, another 403, or another refusal stops at once, and the Workflow
step does not retry it (`NonRetryableError`). A project with no connected
repository is a refusal too. The token request uses the same rate-limit rule
(`isGitHubRateLimited`): a rate-limited 403 is retried. A lost installation (the
token request answers 401, 403, 404, or 422) is a refusal only when a second ask,
2 seconds later, gets the same answer. Then the context step fails, the job is marked failed, and the run log shows
`generation_context_unavailable` with a message that names
`.doxa/instructions.md`. A run never continues without the file, because that
would change the fingerprint. Other context errors show a generic message, so no
internal detail reaches the user.

## When the Instructions Change

### The Fingerprint

The fingerprint (`projectInstructionsFingerprintInput`) leaves out the version
number and the screening method. It sorts the lists whose order means nothing:
page types, "Do not document" paths, terminology, and screening flags. The order
of code languages and rules stays. Default instructions, with no flagged text and
no repository file, count as no instructions: the fingerprint, the brief
fingerprint, and the prompts are the same as for a project without instructions.
The API, the agent, and the container compute the same value. A project that
saved the defaults before this release re-analyzes once, because its brief
fingerprint changes to the one of no instructions.

### The Next Run

A change of fingerprint makes a full analysis and a new structure, anchored to the
published one. The structure prompt then uses other continuity rules: it can
rename for terminology, rewrite descriptions for the readers and tone, and drop
or merge pages that the instructions rule out. The review accepts a drop that
cites an instruction. These rules apply also when the planning contract changed
in the same run.

Each page the baseline has is then edited from its published text. A page is
written fresh instead when the planning or writing fingerprint also changed.
Template pages, such as REST endpoint pages, are rendered again without a model.

The page cache key holds the instructions fingerprint and, for an edit, the
content hash of the page text that the edit starts from. That text is the copy in
the generation state of the published version (`readPreviousPages`), so an edit
made in the review or the editor after that run is not part of it. A cached page
is reused only for the same instructions and the same starting text.

### Pages That Fall Behind

Each page state stores the fingerprint that it was written with. A page is behind
when its own fingerprint is not the fingerprint of the published run, for example
a page that a run kept after a failure. A later run with the same instructions
edits it again (`catchUpPageIds`). In the run where the instructions change, there
are no catch-up pages: every page is written as part of the change and counts
toward the failure budget.

A catch-up page does not count toward the page failure budget, so it cannot fail
an unrelated run. The budget check runs in its own step
(`check <scope> page failure budget`), so a run that it stops names that step in
the run log. The site keeps one catch-up ledger outside its published state
(`sites/<siteId>/generation-state/instruction-catch-up.json`). Every revision-aware
production run updates it, published or not, and also a run that stops on its
page failure budget. So a run whose only work is a failed catch-up still counts.
The older production path writes every page and has no catch-up pages.

The ledger rules:

- A failed catch-up adds 1 to the page. A retried step does not count twice
  (`lastJobId`).
- A run that writes a page neither counts nor clears it, because the page stays
  behind until its version is published.
- Entries for pages that are no longer behind in the published state, or no
  longer in the structure, leave the ledger.
- A run with new instructions starts a new ledger, so the count starts again.
- A missing or malformed ledger counts as empty. A failed read skips the update.
  A write is conditional on the version that was read, so it never overwrites a
  ledger that changed in the meantime.

After 3 failed catch-ups under the same instructions
(`MAX_INSTRUCTION_CATCH_UP_ATTEMPTS`), runs stop trying the page, and it gets a
`behind_instructions` notice in the run log and the review.

A locked page stays as the person left it and never catches up. The review flags
it in the run where the instructions changed, or when the new plan removed it. It
is not flagged again in later runs, and it gets no notice.

The admission check before "Generate docs" compares the fingerprints. The manifest
also lists the pages behind the instructions (`behindInstructionPageIds`, without
locked pages), and admission leaves out the pages that the ledger marks as
exhausted. If it cannot read the published state, it says that it could not
compare them. A lock change after a run reaches admission only after the next run
writes the manifest.

### Deploy Order

Deploy the API first, then the agent container, then the agent worker, in quick
succession. An older API cannot read review flags with new fields. An older
worker refuses a plan with `catchUpPageIds`, and an older container refuses a
manifest with `behindInstructionPageIds` or a reusable state with
`instructionCatchUp`. No published
state has these fields before the new worker runs, so this order is safe. Stored
review flags now drop unknown fields when read, and stored instructions with old
globs still parse (`storedDoxabotInstructionsSchema`).

A dashboard tab on the previous web build parses the review strictly, so it does
not read `pageNotices` and loads that section from its own endpoint. A reload
fixes it.

A run that started before this release keeps the old behavior when it continues
(`writePhaseOutcomeOf`): every planned page counts toward the budget, and it
writes no ledger and no notices.

Do not roll the worker back after new states exist. An older worker cannot parse
them, treats the state as unavailable, and writes every page again, which costs
one full run per project.

## Repository Documents

A file under `docs/` is evidence for the planner (`repositoryDocuments` in the
analysis), not a page. The planner plans a page from a file only when it serves
the reader. This rule exists because `docs/current` of this repository became 21
public pages (generation `fa822e61`). See
`packages/agent/tests/collection-injection-incident.test.ts`.

Collections are for repeated user-facing surfaces, such as providers. Injection,
structure validation, writer validation, and the planner prompt all read one list
(`collectionsWithPages`), so a page that one of them requires is never a page that
another one refused to add.
