# REST endpoint pages and editorial budget separation

Fixes the structure-review failure that killed generation `fdfd994f`, moves REST
reference to one page per endpoint grouped by resource, and separates the
editorial budget from mechanically-derived reference inventory so the two stop
fighting each other.

## Goals

1. A structure review can never fail because it was asked to perform an action
   its decision schema forbids.
2. REST reference documents **one page per endpoint**, grouped by resource, with
   the HTTP method and path visible in navigation.
3. The editorial page budget governs **prose pages only**. Reference inventory
   expands to full coverage without competing for that budget.
4. A REST surface is represented once, not twice.

## Evidence this is needed

Generation `fdfd994f` (2026-08-03, production, 7m 01s, failed):

```
proposedPageCount = 43        ceiling = 36
"REST API resource groups"  8 items -> 1 parent + 8 children =  9 pages
"Public packages"           4 items -> 1 parent + 4 children =  5 pages
review attempt 1/3, 2/3, 3/3 -> all rejected -> NonRetryableError
```

The reviewer's only verbs are `keep | merge | move | drop`. Its rejection message
was *"Create a parent page with child pages for each item"* — an action it cannot
perform. A legal answer existed (drop 7 of ~29 discretionary pages), but nothing
in its payload marks which pages are mandatory, and the feedback never says
"issue `keep` for pageId X".

---

## Task 1 — Stop the review loop from failing on impossible instructions

**This is the bug that failed the run. Land it first; it is independent of the
REST work.**

### 1a. Show the reviewer which pages are mandatory

`packages/agent/src/doxa-agent/prompts/dynamic/builders.ts`,
`structurePagesForPrompt` currently emits:

```
pageId, sectionId, sectionTitle, title, description, childPages, sourceEvidence
```

Add `collectionId` and `reference` (kind + groupId/moduleId) so collection- and
reference-backed pages are distinguishable from discretionary prose pages. Add a
`mandatory: true` flag on pages that `validateCollectionCoverage` or
`validateReferenceCoverage` would require.

Extend the review prompt rules with:

```
7. Pages marked "mandatory" are derived from the project's own inventory.
   You may `move` them. You may not `drop` or `merge` them.
   Reduce page count by acting on unmarked pages only.
```

### 1b. Make rejection feedback actionable in review context

The message in `validators.ts:279` is written for the structure *generation*
stage, where creating pages is the model's job. Reused verbatim in review, it
instructs an impossible action.

Give `validateCollectionCoverage` and `validateReferenceCoverage` a caller-supplied
phrasing mode:

| stage | message |
|---|---|
| generation | `Create a parent page with child pages for each item.` (unchanged) |
| review | `Issue "keep" for pageId <id> instead of dropping it.` |

The review-mode message must name the concrete `pageId` that was dropped, which
is recoverable by diffing the reviewed structure against `input.structure`.

### 1c. Never fail a generation on review exhaustion

After `maxAttempts`, do **not** throw. Fall back to the last structurally valid
candidate in this order:

1. the most recent reviewed structure whose only failures were budget-related
2. the original proposal with review decisions discarded

Emit a `structure_review_degraded` job event naming the unresolved errors.
Publishing a slightly-too-large structure is strictly better than failing a run
that already spent a full cold analysis.

Keep `StructureReviewFailedError` for genuinely unusable output (unparseable
JSON on every attempt).

### Tests

- Review payload marks collection and reference pages as `mandatory`.
- Review-mode coverage failure names a `pageId` and never says "Create a parent page".
- Generation-mode message is unchanged (byte-identical prompt guard).
- Three failed attempts produce a degraded structure plus the event, not a throw.
- Unparseable JSON on all three attempts still raises `StructureReviewFailedError`.

---

## Task 2 — One REST page per endpoint, grouped by resource

### Target shape

```
REST API                       (section)
  Environments                 (group parent page)
    GET    /projects/:id/environments
    POST   /projects/:id/environments
    GET    /projects/:id/environments/:key
  Flags                        (group parent page)
    GET    /projects/:id/flags
    ...
```

`/user/auth` exposing `GET` and `POST` produces **two** child pages.

### What already exists — do not rebuild it

| capability | location | status |
|---|---|---|
| `endpointId`, `method`, `path` on page refs | `types.ts:39` `PageReferenceMetadata` | ready |
| Writer resolves a single endpoint | `writer.ts:309` | ready |
| Writer branches group vs endpoint | `writer.ts:313` | ready |
| Evidence bundle per endpoint | `evidence-bundle.ts:150` | ready |
| Nav badge renders the method | `nav-order.ts:222` | ready |
| Quality validator accepts per-endpoint pages | `docs-quality-validator.ts:215` | ready |
| Parser reads `endpointId` from model output | `json-parsing.ts:110` | ready |
| **Group page emits endpoint children** | `reference-surfaces.ts:142` | **missing** |

The only structural gap is `createRestGroupPage` hardcoding `subPages: []`.

### 2a. Emit endpoint children

In `createRestGroupPage`, replace `subPages: []` with one entry per endpoint:

```ts
subPages: group.endpoints.map((endpoint) => ({
  id: endpointPageId(endpoint),
  title: endpointPageTitle(endpoint),          // e.g. "GET /environments/:key"
  description: endpoint.description,
  sourceEvidence: endpoint.sourceEvidence,
  audience: "reference",
  reference: {
    kind: "rest",
    groupId: group.id,
    endpointId: endpoint.id,
    method: endpoint.method,
    path: endpoint.path,
  },
})),
```

Keep the group page itself as the overview that links its children.

### 2b. Endpoint IDs must be unique per method **and** path

**This is the trap.** Existing fixtures derive endpoint IDs from path alone
(`apps/agent-container` and agent test fixtures use `id: path.slice(1)`).
`GET /user/auth` and `POST /user/auth` would collide, and
`validateGlobalPageIds` would reject the structure — the same duplicate-ID class
that failed generation `2d55e3a7`.

Add `endpointPageId(endpoint)` deriving from `method` + `path`:

```
GET  /projects/:projectId/environments/:environmentKey
  -> get-projects-environments-environment-key
```

Normalize: lowercase, strip `:` and `{}` param markers, collapse separators,
prefix the method. Do **not** trust `endpoint.id` for page identity — treat it as
the analysis-side key that `reference.endpointId` carries.

Assert uniqueness within a group and fail loudly if two endpoints collide.

### 2c. Update the structure prompt rules

`prompts/dynamic/modules.ts`, `structure-universal-rules` currently says:

```
- Keep reference granularity bounded: create one page per endpoint group and one
  page per public module. Cover individual endpoints, exports, classes, and
  members inside those pages; never create one generated page per symbol.
```

Replace the REST half:

```
- REST API reference: create one parent page per endpoint group and one child
  page per endpoint. Each child covers exactly one HTTP method and path.
- SDK reference: keep one page per public module. Cover exports, classes, and
  members inside that page; never create one page per symbol.
```

SDK granularity is deliberately unchanged — see Open decisions.

### 2d. Writer expectations for endpoint pages

`writer.ts:313` already branches on `group && !reference.endpointId`. Verify the
endpoint-level branch supplies method, path, auth, request/response schema, and
errors from `RestApiReferenceEndpoint`, and that the page template produces a
single-endpoint reference page rather than a group summary.

### Tests

- A group with `GET` and `POST` on the same path yields two child pages with
  distinct IDs and correct `method`/`path` metadata.
- `validateGlobalPageIds` returns `[]` for a structure built from a group whose
  endpoints share a path.
- `validateReferenceCoverage` passes with per-endpoint pages and no group-level
  page (already supported at `docs-quality-validator.ts:215`).
- Nav renders the method badge for endpoint children (`nav-order.ts:222`).
- Endpoint ID derivation is stable across runs for identical input.

---

## Task 3 — Separate the editorial budget from reference inventory

Task 2 is impossible without this. FlagForge's analysis carries **21 endpoints
across 8 groups**, so per-endpoint pages alone are `8 + 21 = 29` pages against a
total ceiling of **36**, before a single guide, concept, or quickstart page.

### The distinction

| kind | source | should the budget constrain it? |
|---|---|---|
| prose — overview, quickstart, guides, concepts, troubleshooting | editorial judgment | **yes** |
| reference — REST endpoints, SDK exports, collection children | mechanically derived from the analysis | **no** |

Reference pages are inventory. Trimming them produces incomplete documentation,
not tighter documentation. The editorial budget exists to prevent thin, repetitive
*prose*.

### 3a. Budget counts editorial pages only

`structure-review.ts`, `pageCount()` currently counts `1 + subPages.length` for
every page. Introduce `editorialPageCount()` that skips pages carrying
`reference` metadata or a `collectionId`, and their children. Point
`validateReviewedStructure`'s ceiling check at it.

Keep `DEFAULT_FULL_PROD_EDITORIAL_PAGE_BUDGET = 36` — under the new definition it
governs roughly 20–29 prose pages for FlagForge, which is a realistic editorial
target rather than an unsatisfiable one.

### 3b. Add a total-page safety cap

The editorial budget no longer bounds total output, so add an independent cap on
total pages (reference included) to prevent a runaway analysis producing hundreds
of model calls. Suggested `DEFAULT_TOTAL_PAGE_CAP = 120`, configurable, and
breaching it is an `infeasible_constraints` failure with the arithmetic in the
message — not a reviewer retry.

### 3c. Update the prompt ceilings

Both prompts state a hard ceiling that now means something different. Replace
with an editorial framing:

```
EDITORIAL PAGE BUDGET: at most 36 guide, concept, and workflow pages.
Reference pages generated from the project's API surface do not count toward
this budget and must not be dropped to satisfy it.
```

### Tests

- `editorialPageCount` excludes reference and collection pages and their children.
- A structure with 29 reference pages and 20 prose pages passes a budget of 36.
- The same structure with 40 prose pages fails the budget.
- Exceeding the total cap raises `StructureInfeasibleConstraintsError` before any
  model call.

---

## Task 4 — Stop representing a REST surface twice

The `fdfd994f` analysis contained a `documentationCollections` entry titled
**"REST API resource groups"** (8 items) *and* a `referenceSurfaces.rest` surface
covering the same groups. Two independent machineries then generated pages for
the same material — a strong candidate for the repetition that made the 81-page
site "very bad", especially on the REST and SDK sides.

### 4a. Tighten the analysis prompt

`prompts/dynamic/builders.ts`, analysis requirements. Add:

```
- documentationCollections must NOT restate reference surfaces. HTTP/RPC endpoints
  belong in referenceSurfaces.rest and SDK exports belong in referenceSurfaces.sdk.
  Collections are for repeated non-reference surfaces such as providers, adapters,
  integrations, plugins, or command families.
```

### 4b. Deterministic de-duplication

Prompt guidance is not a guarantee. After parsing the analysis, drop any
`documentationCollection` whose items substantially overlap a reference surface
group or module — match on title similarity plus `sourceEvidence` path overlap.
Log what was dropped and why.

Deterministic beats prompted here, and it protects every existing project whose
analysis already carries the duplicate.

### Tests

- An analysis with both a "REST API resource groups" collection and a matching
  `referenceSurfaces.rest` retains only the reference surface.
- A genuine non-reference collection (providers, adapters) is untouched.
- De-duplication is stable across runs.

---

## Sequencing

| order | task | why |
|---|---|---|
| 1 | Task 1 | fixes the live failure; independent; unblocks any production run |
| 2 | Task 4 | removes duplicate pages before changing granularity, so page counts are measured on clean input |
| 3 | Task 3 | must precede Task 2 or the budget makes per-endpoint pages impossible |
| 4 | Task 2 | the granularity change itself |

Run a production generation after Task 1 to confirm the pipeline completes, and
again after Task 2 to see the resulting page composition.

## Verification

```
pnpm typecheck
pnpm --filter @doxahq/agent test
pnpm --filter @doxahq/agent-container test
pnpm --filter @doxahq/agent-worker test
pnpm --filter @doxahq/api test
pnpm --filter @doxahq/agent-container test -- synthetic-generation-pipeline
cd apps/agent-worker && npx wrangler deploy --dry-run --outdir /tmp/bundle-check
```

Baselines to match or exceed: agent 310, container 131, worker 106, api 275,
generation 76, synthetic 2/2.

**Acceptance:** a production generation for FlagForge completes, publishes a REST
section with one page per endpoint grouped by resource, shows the HTTP method in
navigation, and contains no duplicate REST representation.

## Do not

- Do not change SDK export granularity in this plan.
- Do not remove the editorial budget; redefine what it counts.
- Do not trust `endpoint.id` for page identity — derive from method plus path.
- Do not reuse the generation-stage coverage message in review context.
- Do not touch the model-call deadline, `mergePages`, or the review error
  classification from `55885d6`.

## Open decisions

1. **SDK granularity.** The validator already supports per-export pages
   (`docs-quality-validator.ts:250`). FlagForge's SDK surface would expand
   substantially. Left at one page per module until explicitly requested.
2. **Total page cap value.** 120 is a guess. Set it from the largest realistic
   project once Task 2 lands and real counts are known.
3. **Collection children and the budget.** Task 3 exempts them alongside
   reference pages. If collection sprawl reappears, the lever is
   `MIN_DOCUMENTATION_COLLECTION_ITEMS` or the analysis, not the reviewer.
