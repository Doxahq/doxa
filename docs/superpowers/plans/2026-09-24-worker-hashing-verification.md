# Portable artifact hashing: verification

The site config writer imported `node:crypto` through the shared docs-engine entrypoint.
Both the docs runtime and agent Worker crashed because they do not enable Node compatibility.
The fix reuses `hashSiteConfig` and awaits artifact creation at every caller.
No Wrangler flags, dependencies, artifact schemas, or frozen fixtures change.

## Test strategy

```yaml
test_strategy:
  artifact: "docs-engine artifact writers and their Worker consumers"
  rationale: "Node-based tests missed a module import that prevents Workerd startup."
  criticality: "HIGH"
  selected_types:
    - rationale: "The portable hash must match SHA-256 over the stored UTF-8 bytes."
      type: "unit"
      size: "small"
      framework: "vitest"
      dependencies: ["native Web Crypto", "Node crypto as an independent oracle"]
      gate: "Gate 1"
    - rationale: "Both real Worker entrypoints must load without Node compatibility."
      type: "integration"
      size: "medium"
      framework: "node:test"
      dependencies: ["installed Wrangler esbuild and Miniflare", "local Workerd"]
      gate: "Gate 2"
    - rationale: "Published artifact bytes and reader compatibility must not change."
      type: "contract"
      size: "small"
      framework: "vitest"
      dependencies: ["frozen schema-v1 and schema-v2 artifact fixtures"]
      gate: "Gate 4"
  rejected_types:
    - reason: "No UI behavior changes. Gate 3 does not apply."
      type: "component"
    - reason: "The failure occurs before browser requests reach the Worker. Gate 3 does not apply."
      type: "e2e"
    - reason: "No deployment is authorized. The local integration test covers startup."
      type: "smoke"
    - reason: "This change reuses an existing hash function, with independent byte checks and frozen contracts."
      type: "property-based"
  deliberately_skipped:
    - why: "The local startup checks reproduce the failure without credentials or remote changes."
      what: "Production deployment and live generation"
    - why: "The full dev command starts additional services and can interfere with the user's stack."
      what: "Launching pnpm dev as a whole"
```

## Cases covered

- [integration] Given each real Worker bundle and its existing flags, startup succeeds and a root request returns HTTP 200.
- [unit] Given ASCII or Unicode config, the stored bytes produce the same digest with Web Crypto and Node crypto.
- [contract] Given each current-writer recipe, all generated files match its frozen fixture byte for byte.
- [contract] Given the legacy and v2 fixtures, the runtime and renderer compatibility suites pass.

## Results

- Before the fix, both startup tests failed with `No such module "node:crypto"`.
- After the fix, both startup tests passed. The test uses ephemeral ports and blocks outbound requests.
- Tests passed for docs-engine, fixtures, runtime, renderer, API, agent Worker, and agent container: 1,337 tests.
- Typechecks passed for those seven packages.
- All 25 root script tests passed, including the two new startup tests.
- `git diff --check` passed. No frozen fixture changes were made for this fix.
- Full `pnpm test` failed because the container suite discovered six foreign suites inside existing `.workspaces` checkouts.
- The container suite passed all 159 tests with `--exclude '**/.workspaces/**'`. Those checkouts remain unchanged.

The new startup test is part of the root `pnpm test` command.
No commit, deployment, migration, or full-stack startup was performed.
