# Local Generation Security Audit Implementation Plan

> **Status (2026-10-27): complete. Historical record only, do not execute.** The audit found nine findings (F1–F9). All nine were fixed on 2026-10-27, and a fresh lab campaign then passed. The lab now lives in `apps/agent-container/security/`; see its README to run it.

**Goal:** Run the approved production-image lab, audit the corpus, and report issues without fixing production code.

**Architecture:** Build the existing production Dockerfile. Call its normal staged HTTP routes on an internal Docker network with local TLS Git/model peers. Record model traffic, tool results, system calls, packets, output pages, and errors. Retain evidence per run.

**Tech Stack:** Existing Node 26 production image, Docker, Node built-ins, OpenSSL, test-only packet/syscall observer, Vitest and node:test.

**Spec:** `docs/superpowers/specs/2026-10-26-local-generation-security-design.md` (approved in conversation).

## Global Constraints

- No production source fixes, commits, deploys, migrations, production test runs, real credentials in test containers, or shared Docker cleanup.
- Keep existing failing regression assertions intact. Harness defects can be corrected; system findings remain for user review.
- Keep the production entry point, provider adapter, tools, validators, and checkout implementation active.
- Record deterministic-model limits. Do not label fixed model responses as real-model injection resistance.
- Preserve evidence under `.artifacts/security-audit/` and bypass inputs only in corpus/test files.

## Review Focus

- A leak in an object key, URL encoding, nested error, or model prompt must be detected.
- Automatic reads must be visible even when there is no Read tool call.
- A missing recorder or setup failure cannot count as PASS.
- Partial failures and interruptions must preserve evidence and clean up only lab-owned resources.
- External links in escaped source text differ from active links in renderer AST.

### Task 1: Evidence scanner and protocol fixture

Files: create `apps/agent-container/security/{scan,protocol,peer}.mjs` and `security/lab.test.mjs`.

- [x] Write scanner tests for clean results, canary encodings, denied reads, outside connections, and missing evidence. Observe failure before implementation.
- [x] Implement scanner with explicit PASS/FAIL/UNVERIFIED verdicts and separate source/AST findings.
- [x] Implement Anthropic protocol responses and local Git smart HTTP, without production provider overrides.
- [x] Verify with `node --test apps/agent-container/security/lab.test.mjs`.

### Task 2: Container driver and observer

Files: create `security/{run,observe}.mjs`, `security/Observer.Dockerfile`, and `security/README.md`.

- [x] Build production image and record build identity. Add only test-side TLS trust and environment canaries at runtime.
- [x] Create a temporary owned Git fixture and isolated network. Start local TLS peers.
- [x] Attach packet/syscall observer before requests. Verify it detects deliberate lab-only probes.
- [x] Complete normal plan/write through the production server. Save all streams and parsed renderer output.
- [x] Verify cleanup on failure and success. Preserve local artifacts.

### Task 3: Corpus and review

Files: update audit artifacts and test-only regression coverage as required.

- [x] Run owner/editor and repository-file cases, plus repository-note cases, with fresh containers and run IDs.
- [x] Exercise explicit malicious tool actions and drafts, separately from disclosure-origin checks.
- [x] Run focused regressions in the Node 26 image, preserving red security failures.
- [x] Review the complete lab with a fresh reviewer; correct harness validity defects only.
- [x] Write final ranked report with evidence, scope limits, per-case verdicts, and remaining production read-only gaps.
- [x] Report completion to the user and wait for issue review before fixes.
