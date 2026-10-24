# @doxahq/docs-artifact-fixtures

Frozen docs artifact sets for the artifact compatibility gate.

Each set under `sets/schema-v{N}/{name}/` is one immutable artifact set as a
writer of schema version N published it. The evergreen renderer must read
every set forever. The contract is documented in
[`docs/current/docs-artifact-compatibility.md`](../../docs/current/docs-artifact-compatibility.md).

## Layout

```text
recipes/{name}/recipe.json    input for create-set: identity, navigation, pages
recipes/{name}/pages/*.mdx    page sources for the recipe
sets/schema-v{N}/{name}/set.json        identity of the frozen set
sets/schema-v{N}/{name}/artifacts/**    the artifact objects, byte for byte
sets/schema-v{N}/{name}/expected/**     golden reader outputs
```

The golden files are written by the reader suites:

- `expected/route-data/*.json`, `expected/sections.json`,
  `expected/navigation/*.json`, `expected/features.json`, and
  `expected/prerender-plan.json` come from
  `apps/docs-runtime/tests/artifact-schema-compat.test.ts`.
- `expected/components/*.json` comes from
  `apps/docs-template/src/runtime/artifact-schema-compat.test.ts`.

## Rules

- Never edit a file under `sets/`. Add a new set instead.
- Never regenerate a golden file to make a suite pass. Fix the reader.
- A new schema version gets a new `sets/schema-v{N}/` folder. The older
  folders stay.

## Commands

```bash
pnpm --filter @doxahq/docs-artifact-fixtures test
pnpm --filter @doxahq/docs-artifact-fixtures create-set <recipe-name>
```

`create-set` freezes a recipe with the current writer under the current
schema version. It refuses to overwrite an existing set.
