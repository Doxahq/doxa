# Page-Scoped Cumulative Validation History

## Goal

Give every page-writing retry the complete validation history for that page while making the latest unresolved issues unmistakable. Validation history must never cross page boundaries.

## Scope

This change covers writer-level validation attempts and the bounded outer retry for one failed page. It does not combine histories from different pages, change validation rules, change the five-attempt writer budget, or increase the outer page-retry budget.

## History Model

Each page generation owns a structured validation ledger. One entry represents one failed writer attempt and records:

- the writer attempt number and outer page-retry number;
- provider finish reason, when present;
- every validation issue, including rule, severity, message, fix instruction, location, and issue snippet;
- the debug artifact path;
- a bounded excerpt of that attempt's failed output for diagnostics and error recovery.

The ledger is created inside the page's generation/retry flow. It is passed across that page's outer retry through structured error data, not by recursively embedding previously rendered prompt strings. A successful or terminal page discards its ledger. A different page always starts with an empty ledger, including when pages are written concurrently.

With three writer attempts and one outer retry, a page can contribute at most six ledger entries. Every issue occurrence remains represented in structured state. The prompt renderer retains only the fields the writer needs and enforces a 6,000-character feedback ceiling, approximately 1,500 tokens for typical English and code. Current issues always receive budget before historical references.

## Retry Prompt

Before a retry, the ledger renderer separates the newest entry from all older entries.

### Current outstanding validation issues

The latest failed attempt is labeled as the authoritative work list. Each issue is rendered on a compact line containing its rule, location, short message, repair action, and issue-local snippet when available. Severity is omitted when every issue is hard. Provider finish reason is omitted unless it changes the repair action, such as a token-limit failure.

The renderer does not include the full current page by default. It adds one short failed-output excerpt only when the validator did not provide a useful issue snippet or when wider context is required for a token-limit failure. The prompt explicitly tells the writer to fix every issue in this section now.

### Previous validation history

Earlier entries appear chronologically and are labeled reference-only. Each attempt occupies one compact line containing the page-retry/attempt identity plus rule and location pairs, for example `r0.a2 unexpected-character@42, unknown-component@18`. Historical messages, repair instructions, debug paths, and raw-output excerpts are not repeated. The prompt tells the writer that these issues may already be fixed, but it must not reintroduce them. Repeated rules remain visible at each attempt where they occurred so the writer can recognize a recurring failure pattern.

The complete ledger remains available to application diagnostics, but the model receives this compact projection only. Rendered prompt strings are never stored back into the ledger, preventing recursive prompt growth.

The target prompt shape is:

```txt
RETRY VALIDATION
FIX NOW r0.a3
- unexpected-character@42: <short message> Fix: <short action> Snip: <bounded snippet>
AVOID REGRESSIONS
- r0.a1 residual-frontmatter@1
- r0.a2 unexpected-character@38
Return corrected MDX only.
```

Labels and instructions appear once. Empty sections and unavailable fields are omitted.

## Data Flow

1. A page starts with an empty validation ledger.
2. The writer produces an attempt and the server-side validator evaluates it.
3. On failure, the pipeline appends a structured entry to that page's ledger.
4. The renderer builds the next prompt with the newest entry as current and all earlier entries as reference history.
5. If all three writer attempts fail, the structured ledger travels with `PageValidationExhaustedError` into the outer retry for the same page.
6. The outer retry continues the same ledger and numbers new entries under the new page-retry cycle.
7. Success or terminal failure ends and discards the ledger. The next page receives no part of it.

Token-limit failures use the same ledger so later attempts retain the earlier concision instruction. Non-validation infrastructure failures remain operational errors and are not converted into another page's validation history.

## Error and Context Boundaries

- History ownership is keyed by the current page execution, not stored globally or in shared generation state.
- Concurrent page writers never share mutable history arrays.
- Rendered prompt text is derived from structured entries on demand, preventing recursive duplication.
- The current issues always take precedence over historical issues.
- Historical issues are never described as still failing unless they also appear in the newest entry.
- Debug paths and full previous outputs remain operational diagnostics and are not sent to the model.
- If the 6,000-character ceiling is reached, the renderer truncates messages, repair text, and snippets before dropping issue identity, attempt identity, or chronology.

## Tests

Automated coverage will verify:

1. Three sequential failures render the third attempt as current and the first two chronologically as history.
2. A repeated issue remains visible under every attempt where it occurred.
3. The outer page retry receives and extends the first writer run's ledger.
4. Two pages generated concurrently receive only their own histories.
5. A successful page does not leak history into the next page.
6. Token-limit feedback remains actionable without including unrelated raw output.
7. Rendered feedback remains at or below 6,000 characters while retaining every issue and attempt identity.
8. Debug paths and full historical outputs are absent from the model prompt.

## Acceptance Criteria

- Every retry sees all earlier validation issues for the same page.
- The latest unresolved issues are explicitly separated and labeled as the required fixes.
- Older issues are explicitly labeled reference-only with an instruction not to reintroduce them.
- No validation history from one page appears in another page's prompt.
- The outer retry preserves the failed page's structured ledger.
- Retry context remains bounded and does not recursively duplicate prior prompt text.
- Retry feedback never exceeds 6,000 characters and omits non-actionable diagnostics.
