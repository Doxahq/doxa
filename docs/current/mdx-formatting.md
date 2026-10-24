# MDX formatting

Every Doxa writer emits page MDX in one Markdown style. The shared function is
`formatMdx()` in `@doxahq/mdx-runtime/format`. It is a separate package entry,
so the docs renderer bundle does not include it.

## Who calls it

| Writer | Where |
|---|---|
| Generation agent and Doxabot updates | `packages/agent/src/doxa-agent/writer-pipeline.ts`, `composeFinal`, before the last `validatePage` |
| Dashboard Write mode (planned) | Edited blocks only. See `docs/superpowers/plans/2026-09-27-dashboard-redesign.md`. |

The dashboard MDX mode saves text exactly as the user types it.

## Style

| Construct | Output |
|---|---|
| Bullet list | `- item` |
| Ordered list | `1. item` |
| Strong, emphasis | `**strong**`, `_emphasis_` |
| Code fence | three backticks |
| Heading | `#` style, never setext |
| Thematic break | `---` |
| Component attribute | double quotes |
| Component children | indented two spaces per level, no blank lines around them |
| Table | columns padded and aligned |

## Rules

- The frontmatter text is kept exactly.
- A top-level block that holds JavaScript (an `{…}` expression, a spread
  attribute, `import` or `export`) keeps its original text. The serializer would
  rewrite whitespace inside template strings, which changes component props.
- A body that does not parse comes back unchanged. The caller's validation
  reports the error.
- Formatting does not change the rendered page: `parseRuntimeMdx(page)` and
  `parseRuntimeMdx(formatMdx(page))` are deep-equal.
- The function is idempotent.
- Published pages are not rewritten in bulk. A page gets the style the next
  time a writer produces it. Readers accept both styles, so no artifact schema
  change is needed.

## Tests

- `packages/mdx-runtime/tests/format.test.ts`: render parity and idempotence on
  every page in `packages/docs-artifact-fixtures/sets` (read only), plus style,
  frontmatter, expression, and invalid-input cases.
- `packages/agent/tests/writer-format.test.ts`: the writer output uses the
  style.
