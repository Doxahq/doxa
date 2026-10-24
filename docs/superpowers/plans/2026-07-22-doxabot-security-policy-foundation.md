# Doxabot Security and Policy Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make automated hosted generation safe enough to run on untrusted pull-request code and establish a provider-neutral, private-repository-only Doxabot policy.

**Architecture:** All repository access passes through a root-containment utility, hosted generation receives an explicit read-only tool policy, Git credentials are supplied ephemerally through `GIT_ASKPASS`, webhook authentication fails closed, and a pure eligibility policy combines deployment flags, repository visibility, project readiness, and user settings.

**Tech Stack:** TypeScript, Node path/fs APIs, Zod, Vitest, Cloudflare Worker bindings, Git CLI.

## Global Constraints

- This phase must land before any webhook is allowed to create a generation job.
- Do not change production Wrangler secrets or bindings without explicit approval.
- Public repositories must evaluate to `public_repository_disabled` unless the future-facing policy flag is explicitly true in a unit test.
- Repository content is untrusted input. Symlinks, absolute paths, traversal segments, `.git`, and shell execution are security boundaries.
- Prefer small pure functions and typed domain errors. Never hide a denied action by returning empty content.

---

## Task 1: Contain every agent file read inside the checkout

**Files:**

- Create: `packages/agent/src/core/tools/project-path.ts`
- Create: `packages/agent/tests/project-path.test.ts`
- Modify: `packages/agent/src/core/tools/read.ts`
- Modify: `packages/agent/src/core/tools/glob.ts`
- Modify: `packages/agent/src/core/tools/grep.ts`
- Modify: `packages/agent/src/core/tools/index.ts`

- [x] Write failing tests for an absolute outside path, `../` traversal, a symlink escaping the checkout, the `.git` directory, and valid files under the checkout.
- [x] Add `ProjectPathAccessError` with a stable `code` and a message that never includes file contents.
- [x] Implement `resolveProjectPath(projectRoot: string, requestedPath: string): Promise<string>` using both lexical containment and `realpath` containment. Resolve the nearest existing parent before allowing a path that does not yet exist.
- [x] Reject `.git` and descendants even when reached through a symlink.
- [x] Route Read, Glob, and Grep path inputs through the shared resolver. Preserve their existing successful output shapes.
- [x] Run `pnpm --filter @doxahq/agent test -- project-path` and `pnpm --filter @doxahq/agent typecheck`.
- [x] Commit: `security(agent): contain repository tool access`

## Task 2: Disable shell execution in hosted generation

**Files:**

- Modify: `packages/agent/src/types.ts`
- Modify: `packages/agent/src/core/tools/index.ts`
- Modify: `packages/agent/src/doxa-agent/analysis-runner.ts`
- Modify: `packages/agent/src/doxa-agent/generation-service.ts`
- Modify: `apps/agent-container/src/worker-core.ts`
- Create: `packages/agent/tests/tool-policy.test.ts`

- [x] Write failing tests proving that `read_only` exposes repository inspection tools but not Bash, and that `local_shell` preserves the explicit local-development path.
- [x] Add `AgentToolPolicy = "read_only" | "local_shell"` and require a policy at the hosted generation entry point.
- [x] Make tool construction accept the policy and return a typed tool registry without `any` or casting between incompatible registries.
- [x] Set every container-driven generation and staged generation path to `read_only`.
- [x] Keep shell access available only where an existing local CLI caller explicitly selects `local_shell`; do not infer it from environment names.
- [x] Run `pnpm --filter @doxahq/agent test -- tool-policy`, `pnpm --filter @doxahq/agent typecheck`, and `pnpm --filter @doxahq/agent-container typecheck`.
- [x] Commit: `security(agent): enforce hosted read-only tools`

## Task 3: Remove credentials from Git arguments and repository configuration

**Files:**

- Modify: `apps/agent-container/src/git.ts`
- Create: `apps/agent-container/src/git-credentials.ts`
- Create: `apps/agent-container/tests/git-credentials.test.ts`
- Modify: `apps/agent-container/tests/git.test.ts`

- [x] Write failing tests with a sentinel token and assert it never appears in command arguments, standard output, standard error, thrown messages, `.git/config`, or the returned checkout metadata.
- [x] Introduce a `GitCredentialSession` that owns a mode-`0700` temporary directory, a mode-`0700` askpass executable, and a child-only environment variable containing the token.
- [x] Clone and fetch from the clean repository URL with `GIT_ASKPASS`, `GIT_TERMINAL_PROMPT=0`, and no credential helper persistence.
- [x] Reset `origin` to the clean URL after clone and verify it before returning the checkout.
- [x] Dispose the credential session in `finally`, including failed clone and aborted generation paths.
- [x] Redact known credential forms in the Git process error adapter as defense in depth.
- [x] Run `pnpm --filter @doxahq/agent-container test -- git-credentials git` and `pnpm --filter @doxahq/agent-container typecheck`.
- [x] Commit: `security(git): use ephemeral askpass credentials`

## Task 4: Make GitHub webhook verification fail closed

**Files:**

- Modify: `apps/api/src/services/github-webhook.ts`
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/.dev.vars.example`
- Modify: `apps/api/tests/services/github-webhook.test.ts`

- [x] Replace the existing missing-secret acceptance test with tests for missing secret, missing signature, malformed signature, invalid signature, and a valid SHA-256 signature.
- [x] Add `ALLOW_INSECURE_GITHUB_WEBHOOKS` as an optional development-only binding parsed as a boolean.
- [x] Make `verifyGitHubWebhook` return false when the secret is absent unless that explicit development escape hatch is true.
- [x] Refuse to honor the escape hatch when the runtime environment is production.
- [x] Compare raw digest bytes using a constant-time operation and reject signatures not prefixed with `sha256=`.
- [x] Run `pnpm --filter @doxahq/api test -- github-webhook` and `pnpm --filter @doxahq/api typecheck`.
- [x] Commit: `security(api): fail closed on webhook verification`

## Task 5: Add provider-neutral source-control and Doxabot policy contracts

**Files:**

- Create: `packages/contracts/src/source-control.ts`
- Create: `packages/contracts/src/doxabot.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/tests/contracts/doxabot.test.ts`
- Create: `apps/api/src/services/doxabot/eligibility.ts`
- Create: `apps/api/tests/services/doxabot-eligibility.test.ts`
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/.dev.vars.example`

- [x] Define Zod-backed `SourceProvider`, `RepositoryVisibility`, `SourceRevision`, normalized change-proposal event, normalized default-branch-push event, and repository-lifecycle event contracts.
- [x] Define `DoxabotUnavailableReason` as `global_disabled | initial_generation_required | public_repository_disabled | repository_not_connected`.
- [x] Define `DoxabotEligibility` as a discriminated union so unavailable results always carry a reason and available results cannot carry one.
- [x] Add `DOXABOT_ENABLED` and `DOXABOT_PUBLIC_REPOSITORIES_ENABLED` bindings, both defaulting to false.
- [x] Implement `evaluateDoxabotEligibility(input)` as a pure function over deployment policy, repository visibility, connected-repository state, published-version state, and stored project setting.
- [x] Test the full truth table, including public denied by default, public allowed only when the future flag is true, private denied before the first published generation, and global shutdown overriding stored enablement.
- [x] Export only provider-neutral contracts from the package root. Keep GitHub payload types out of `packages/contracts`.
- [x] Run `pnpm --filter @doxahq/contracts typecheck`, `pnpm --filter @doxahq/api test -- doxabot doxabot-eligibility`, and `pnpm --filter @doxahq/api typecheck`.
- [x] Commit: `feat(doxabot): add private-repository eligibility policy`

---

## Phase Verification

- [x] Run `pnpm test`.
- [x] Run `pnpm typecheck`.
- [x] Run `git diff --check`.
- [x] Search changed production files for `any`, `as unknown`, `TODO`, token interpolation into URLs, and `sh -c`; justify any pre-existing matches outside this phase.
- [x] Manually inspect that production defaults leave both Doxabot flags false.
