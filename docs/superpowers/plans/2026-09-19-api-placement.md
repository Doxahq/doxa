# API and docs resolver placement implementation plan

> Execute inline, without subagents. No commit, deployment, migration, or remote mutation is authorized by this plan.

**Goal:** Execute dashboard API requests and uncached docs resolution near PlanetScale in AWS us-east-1, while leaving docs rendering and caching at the edge.

**Approved design:** The user approved the private resolver design and cache/dashboard flows in this conversation. The resolver replaces docs lookup RPC calls in production. It shares the API's existing repositories and hostname resolution rules. It has no public route, no artifact access, and no new cache. The public API's internal HTTP protection remains unchanged.

**Architecture:** Deploy a second default-fetch entrypoint from `apps/api`, with its own Wrangler configuration and narrow environment. A typed client under `packages/contracts` carries hostname/project/slug resolution requests over a service binding. Production docs consumers use that binding; local development retains the existing API transport. Both DB-facing deployments use `placement.region = aws:us-east-1`. Generation RPC is unchanged.

## Tasks

- [x] Add failing resolver/client contract tests: successful host/project/slug resolution, unknown records, malformed input, unsupported methods/routes, upstream failures, malformed responses, no-store responses.
- [x] Implement `apps/api/src/docs-resolver.ts`, a request handler, and `packages/contracts/src/docs-resolver.ts`. Narrow repository environment types without changing their queries. Reuse the existing `resolveDocsHost` function.
- [x] Add consumer tests before switching dispatcher cache misses and runtime host/project/slug lookups to the typed fetch client. Preserve cache policy and pinned-version content access. Resolver errors must not fall back to potentially stale RPC data.
- [x] Add production validation failure tests for wrong placement, public resolver exposure, missing fresh Hyperdrive, named-entrypoint bindings, and displaced edge workers.
- [x] Configure the API and resolver; wire resolver deployment before runtime/renderer in local deploy commands and GitHub Actions. Update renderer configuration validation. Preserve local dev without another required process.
- [x] Run API/runtime/dispatcher tests and typechecks, configuration validator tests, and local Wrangler dry runs. Document rollout, rollback, cache behaviour, and regional verification limitations.

## Test strategy

```yaml
test_strategy:
  artifact: "Private docs resolver and placement wiring"
  rationale: "A new transport must preserve published-version isolation and fail closed."
  criticality: "HIGH"
  selected_types:
    - rationale: "Validate request routing, response parsing, and failure behaviour."
      type: "unit"
      size: "small"
      framework: "vitest"
      dependencies: ["in-memory resolution fixtures"]
      gate: "Gate 1"
    - rationale: "Exercise real client/handler HTTP boundaries and consumer output."
      type: "integration"
      size: "medium"
      framework: "vitest and node:test"
      dependencies: ["in-process Request/Response", "temporary config fixtures"]
      gate: "Gate 2"
    - rationale: "Runtime and dispatcher deploy separately from the resolver."
      type: "contract"
      size: "small"
      framework: "vitest"
      dependencies: ["shared Zod schemas", "real resolver client"]
      gate: "Gate 4"
  rejected_types:
    - reason: "No UI change; transport integration tests cover the changed behaviour."
      type: "e2e"
    - reason: "Finite transport operations and input partitions are covered explicitly."
      type: "property-based"
  deliberately_skipped:
    - why: "Deployment and live service calls require separate approval."
      what: "Production smoke tests and regional latency benchmarks (Gate 5)."
    - why: "Existing repository queries are reused, not rewritten."
      what: "New database infrastructure or migration tests."
```

## Test cases to cover

- [contract] A valid hostname resolves to its exact existing version and artifact paths.
- [contract] Project and slug requests return only the resolved site's metadata.
- [unit] An unknown record returns null; database errors return a non-cacheable failure instead.
- [unit] Invalid JSON, unknown operations, empty identifiers, extra artifact fields, and unsupported methods never reach repositories.
- [integration] Resolver failures do not silently use an older RPC response.
- [integration] Host cache policy, version pinning, and invalidation regression tests still pass.
- [integration] Deployment validation rejects public resolver access, stale-read bindings, incorrect placement, and named-entrypoint resolver bindings.

## Verification boundary

Local tests and Wrangler dry runs cannot prove physical execution location or production speed. After approved deployment, inspect `cf-placement` and compare cold and warm requests from Australia, Japan, and US East. Keep the existing publication invalidation checks.

## Verification results (2026-09-19)

- Full workspace `pnpm typecheck`: passed.
- API: 516 tests passed. Runtime: 28 tests passed. Dispatcher: 79 tests passed.
- Production configuration tests: 23 passed. Production validator passed.
- Wrangler deployment dry runs: API, resolver, runtime, and dispatcher passed.
- Renderer deployment pipeline with `--dry-run --skip-secret`: built, packaged, and validated successfully without uploading or deploying.
- Full `pnpm test` was not green: agent-container test discovery included three test files from an existing ignored `.workspaces` repository checkout. Those files reported no test suite. No agent-container source or test configuration was changed in this task. Rerunning its tests with `--exclude '**/.workspaces/**'` passed all 158 tests across 23 files. The checkout was left untouched.
- No deployment, commit, push, or migration was performed. Production latency remains unmeasured.
