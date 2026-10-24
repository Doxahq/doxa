# Model-Only Targeted MDX Repair Design

**Date:** 2026-07-26

## Objective

Repair located MDX parser failures by asking the configured writer model to
patch the exact failing region of the existing page. Do not mutate the draft
with deterministic repair rules and do not regenerate the complete page during
the targeted repair cycle.

Each page run receives three targeted model-patch attempts. The existing single
outer page retry remains responsible for generating one fresh page after the
first repair cycle is exhausted.

## Scope

This change applies only when page validation returns exactly one hard MDX
parser issue with a reliable line and column.

The following failures keep their existing full writer-attempt behavior:

- token-limit failures;
- exhausted agent loops;
- skeleton or incomplete pages;
- cutoff content;
- multiple simultaneous validation issues;
- validation failures without a reliable parser location;
- validator crashes.

This change does not alter the configured writer model, the writer's general
three-attempt policy, the single outer page retry, generation admission, or
publication behavior.

## Selected Approach

Run a bounded, model-only repair loop against one immutable failed draft:

1. Preserve the exact composed page that failed validation.
2. Resolve the parser line and column to an absolute source offset.
3. Send the writer model the parser rule, message, line, column, offset, and a
   bounded source window around the failure.
4. Require a strict JSON patch containing the draft hash, absolute start and end
   offsets, replacement text, and an explanation.
5. Validate the patch boundaries and draft hash before applying it.
6. Apply each accepted patch to the original immutable draft.
7. Revalidate the complete patched page.
8. Return the first patched page that passes validation.
9. After three unsuccessful patch attempts, throw a page validation error and
   let the existing outer page retry generate one fresh page.

The alternatives were rejected:

- Falling back to full-page generation after the first failed patch spends more
  tokens and can damage unrelated valid content.
- A separate repair agent with repository tools adds unnecessary latency and
  complexity for a bounded syntax correction.

## Repair Contract

The repair model receives:

- immutable draft SHA-256;
- page ID and title;
- outer page retry number;
- targeted repair attempt number;
- parser rule and message;
- one-indexed parser line and column;
- absolute parser offset;
- the bounded local draft window and its absolute offset range;
- the previous patch rejection reason, when applicable.

The repair model must return JSON matching:

```ts
interface MdxRepairPatch {
  draftSha256: string;
  startOffset: number;
  endOffset: number;
  replacement: string;
  explanation: string;
}
```

The patch is accepted only when:

- `draftSha256` matches the immutable source draft;
- offsets are integers within the draft;
- the replacement span is no larger than 512 source characters;
- replacement text is no larger than 2,048 characters;
- the patch overlaps the parser offset;
- applying the patch produces a page that passes complete page validation.

A structurally valid patch that still fails page validation counts as an
unsuccessful targeted repair attempt. The next attempt receives a concise,
structured reason explaining why the previous response was rejected.

## Retry Semantics

Located parser failures use the following state machine:

```text
writer produces draft
  -> complete page validation fails at a reliable parser location
  -> targeted model patch 1 against immutable draft
  -> targeted model patch 2 against immutable draft, if needed
  -> targeted model patch 3 against immutable draft, if needed
  -> PageValidationExhaustedError(attempts: 3)
  -> existing outer page retry generates one fresh draft
  -> up to three targeted model patches against that fresh immutable draft
  -> abort only if the outer retry also exhausts its repair cycle
```

Targeted repair attempts do not call the full page writer. Within one repair
cycle, every model patch targets the same immutable draft rather than a
previously patched intermediate draft.

For a located parser failure, `PageValidationExhaustedError.attempts` reports
the targeted repair attempt count. Validation history retains the outer page
retry number so diagnostics can distinguish the first repair cycle from the
outer retry.

## Component Responsibilities

### Writer pipeline

The writer pipeline classifies whether a validation result is eligible for
targeted repair. It delegates eligible failures to the repair loop and keeps
all other failures on the existing writer retry path.

It must not contain character replacement rules or other deterministic MDX
mutation behavior.

### Model repair service

The model repair service owns the three-attempt loop. It builds the bounded
repair prompt, requests strict JSON, validates patch constraints, applies an
accepted patch to the immutable draft, revalidates the complete page, and
returns either the valid repaired page or an exhaustion result.

Keeping the loop in this service ensures the model receives the exact rejection
reason from the previous attempt without conflating targeted patch attempts
with full writer attempts.

### Patch utilities

Patch utilities remain deterministic validation and application primitives.
They may:

- convert line and column positions to UTF-16 source offsets;
- hash the draft;
- validate patch boundaries and location overlap;
- apply an already validated patch.

They must not decide how page content should be rewritten.

### Generation service

The generation service keeps the existing one-retry page recovery behavior. It
receives the exhausted targeted-repair error, preserves its validation history,
generates one fresh page, and aborts only when that outer retry also fails.

## Diagnostics and Cost Telemetry

Every targeted repair attempt emits:

- page ID and title;
- outer page retry number;
- targeted repair attempt and maximum attempts;
- parser rule, message, line, column, and bounded snippet;
- patch acceptance or rejection status;
- rejection reason;
- complete-page revalidation issue codes;
- repair success status;
- model and token/cost usage through the existing model-usage callback.

The limited-retention repair diagnostic stores the immutable failed draft once
per repair cycle. Individual attempt records reference that cycle rather than
duplicating the complete draft.

Diagnostics remain terminal/internal observability and are not added to the
customer dashboard.

## Failure Handling

The repair service treats these responses as failed attempts rather than
unhandled errors:

- malformed or fenced non-JSON output;
- schema-invalid JSON;
- stale draft hashes;
- negative, reversed, or out-of-range offsets;
- patches that do not overlap the parser location;
- oversized spans or replacements;
- valid patches whose resulting page still fails validation.

Provider transport failures and explicit cancellation continue through the
existing provider and cancellation contracts. Cancellation must stop the
repair cycle immediately.

After targeted repair exhaustion, the error contains the original failed draft,
parser diagnostics, and all three bounded rejection records. It does not claim
that the full page writer ran three times.

## Testing Strategy

### Patch utility tests

- preserve Unicode-aware line/column conversion;
- accept a valid bounded patch;
- reject stale hashes;
- reject distant, oversized, reversed, negative, and out-of-range patches;
- verify patch application changes only the requested range;
- remove deterministic content-repair exports and tests.

### Model repair service tests

- first patch succeeds;
- first patch is rejected and second succeeds;
- third patch succeeds after two different rejection reasons;
- malformed JSON consumes one attempt and feeds its rejection into the next;
- a structurally valid patch that still fails MDX validation consumes one
  attempt;
- all three attempts target the same draft hash and original content;
- no more than three model calls occur;
- cancellation stops subsequent attempts;
- complete exhaustion returns the three attempt records and original draft.

### Writer pipeline tests

- one located parser issue enters the targeted model repair path;
- successful repair returns without another full page-writer call;
- exhausted targeted repair throws with `attempts: 3`;
- multiple or unlocated issues retain the existing full writer retry loop;
- skeleton, cutoff, token-limit, and agent-loop failures retain current retry
  behavior;
- repair diagnostics contain the exact parser location.

### Generation service tests

- first repair-cycle exhaustion triggers exactly one outer page retry;
- recovery during the outer retry completes the page;
- two exhausted three-patch cycles abort the generation;
- validation history keeps the two outer page-retry scopes isolated;
- concurrent pages do not share drafts, rejection history, or attempt counters.

### Regression verification

Run focused patch, writer, generation-batch, and staged-generation tests,
followed by the complete agent test suite, type checking, build verification,
and `git diff --check`.

## Success Criteria

- No deterministic function mutates generated MDX.
- A located parser failure receives at most three model patch attempts per page
  run.
- All attempts within a repair cycle patch the same immutable draft.
- No targeted repair attempt regenerates the complete page.
- The existing single outer page retry still runs after repair exhaustion.
- A generation aborts only after both repair cycles are exhausted.
- Non-parser validation retry behavior remains unchanged.
- Diagnostics accurately separate full writer calls, outer page retries, and
  targeted repair attempts.
