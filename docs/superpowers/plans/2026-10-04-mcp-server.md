# Doxa MCP Server: Implementation Plan

**Status:** Not started.
**Date:** 2026-10-04
**Spec:** `docs/superpowers/specs/2026-10-04-mcp-server-design.md`
**Estimate:** 7.5 to 10 engineer-weeks for one engineer. About 5 weeks for two engineers.

## Rules for every phase

- Read the spec section of a task before you start the task.
- Follow `i-coderone-clean-code` and `AGENTS.md`.
- Define the tests of a task before you write its code.
- Run `git status --short` before you edit and before you finish.
- At the end of each phase, all the commands in "Phase checks" must pass. Then stop for a review.
- Do not commit, deploy, run a migration against a remote database, create a KV namespace, or change DNS without explicit approval. Each phase lists its approval points.
- Update `docs/current/*` in the same phase as the behavior change.

## Phase checks

Run these at the end of each phase:

```bash
pnpm --filter @doxahq/contracts test
pnpm --filter @doxahq/db test
pnpm --filter @doxahq/api test
pnpm --filter @doxahq/api typecheck
pnpm --filter @doxahq/web typecheck
pnpm db:check
```

Add `pnpm --filter @doxahq/web build` when routes, queries, or bundling boundaries change. Add the three artifact compatibility suites when a phase touches `apps/api/src/services/docs-content` or `docs-branches`.

## Overview

| Phase | Goal | Weeks | Depends on |
|---|---|---|---|
| 0 | Spike: prove the library integration | 0.5 | — |
| 1 | Foundations: access layer and service changes | 1–1.5 | 0 |
| 2 | Authorization server, consent, connected agents | 1–1.5 | 1 |
| 3 | MCP Worker, tool framework, read tools | 1 | 1, 2 |
| 4 | Branch, docs, and site settings write tools | 1.5–2 | 3 |
| 5 | Agent actions and approvals | 1.5–2 | 3 |
| 6 | Hardening and launch | 1–1.5 | 4, 5 |

**Two engineers:** after Phase 1, one engineer takes Phase 2 and then Phase 5. The other takes Phase 3 and then Phase 4. Phase 3 needs Phase 2 only for real tokens. Until then, it uses the local dev token stub of task 3.2.

**MVP cut:** Phases 0 to 4, plus Phase 5 with `docs.publish` only. This gives read, branch edits, site settings, and approved publish. Estimate: about 5.5 weeks for one engineer.

---

## Phase 0: Spike

**Goal:** prove that the libraries work together before the real build. Work on a throwaway branch. Delete the spike code at the end.

### Tasks

0.1. Install `agents@0.26.x`, `@modelcontextprotocol/server@2.0.0`, and `@cloudflare/workers-oauth-provider@1.2.x` in a scratch Worker.

0.2. Build a minimal `OAuthAuthorizationServer` with a fake login. Build a minimal `OAuthResourceServer` with `createMcpHandler` and one tool. Connect them with a service binding in local `wrangler dev`.

0.3. Confirm these facts and write the answers in the spec, in a new section "Spike results":

- `handler.fetch(request, { authInfo })` delivers `authInfo` to the tool as `context.http.authInfo`.
- `resourceMetadata.resource` can come from the env, or the server must be built in the first request.
- The revocation endpoint path of the provider.
- `insufficientScope()` returns the challenge that the spec expects, and a client re-authorizes with the new scope.
- The `Mcp-Method` and `Mcp-Name` headers arrive on `tools/call` from 2026 clients.
- A 2025 client (with `initialize`) works through `legacy: "stateless"`.
- CIMD works with a real client that publishes a client ID metadata document.
- `parseAuthRequest` output can be stored as JSON in KV and passed to `completeAuthorization` later.

0.4. Connect MCP Inspector, Claude Code, and Cursor to the spike. Record which protocol version each client uses.

### Exit criteria

- Every item in 0.3 has an answer in the spec.
- If an item fails, update the spec design before Phase 1. Ask the user if the change affects a confirmed decision.

### Approval points

- None. The spike runs locally.

---

## Phase 1: Foundations

**Goal:** the access layer and the changes to current code. The dashboard behavior does not change.

### Tasks

1.1. **Contracts.** Add `packages/contracts/src/agent-access.ts`: `OAUTH_SCOPES`, `OAuthScope`, the scope implication table, `agentGrantPropsSchema`, `projectScopeClaimSchema`. Add the `./agent-access` export to `package.json`. Spec 6.3, 6.4.

1.2. **Access layer.** Add `apps/api/src/services/agent-access/`: `actor.ts`, `scopes.ts`, `capabilities.ts`, `project-access-policy.ts`, `owner-project-access-policy.ts`. Spec 7.1 to 7.4.

- Tests: table-driven tests for `expandScopes`, `SCOPE_CAPABILITIES`, and effective capabilities (spec 18.1).

1.3. **Edit origin.** Add `editOriginFor`. Change `routes/docs-content.ts:64`. Remove `origin` from `applyDocsContentEditsInputSchema`. Update the web client if it sends `origin`. Spec 10.1.

- Tests: the route ignores an `origin` field (the strict schema rejects it). The service receives `"editor"`.

1.4. **Expected revision.** Add `options.expectedRevision` to `DocsContentService.applyEdits`. Spec 10.2.

- Tests: match writes, mismatch throws `conflict` with `currentRevision`, unset keeps the retry loop.

1.5. **Generation start service.** Add `services/generation-start.ts` with `GenerationStartService` and `GenerationDispatcher`. Make the route a thin shell. Spec 10.3.

- Tests: one service test for each outcome. The current route tests in `tests/http/projects.test.ts` pass with no change.

1.6. **Request database scope.** Add `createRequestDbScope` to `packages/db/src/client.ts`. Spec 10.5.

- Tests: two `createDb` calls on one scoped env return the same pool. Two scopes get two pools. `close()` ends the pool. An unscoped env keeps today's behavior.

1.7. **MDX check.** Add `services/docs-content/mdx-check.ts` with `checkMdxSource`. Add `mdx_invalid` to `VALIDATION_ISSUE_CODES` and to the message table. Spec 10.6.

- Tests: valid MDX, an unknown component, a syntax error, frontmatter only.

1.8. **Docs.** Update `docs/current/docs-content-storage.md` or `docs-branching.md` for the origin change and the expected revision.

### Exit criteria

- Phase checks pass. The three artifact compatibility suites pass.
- No dashboard behavior change. The web app builds.

### Approval points

- None. No migration in this phase.

---

## Phase 2: Authorization server, consent, connected agents

**Goal:** an agent can sign in and get a token. The user can see and revoke grants.

### Tasks

2.1. **Dependencies.** Add `@cloudflare/workers-oauth-provider` (exact version from Phase 0) to `apps/api`.

2.2. **Authorization server.** Add `services/oauth/authorization-server.ts` with `createAuthorizationServer` and `isOAuthProviderPath`. Add the dispatcher to `apps/api/src/index.ts`. Spec 6.1, 6.2.

- Tests: the dispatcher sends `/.well-known/oauth-authorization-server`, `/oauth/token`, and `/oauth/register` to the provider, and `/oauth/authorize`, `/projects`, `/health` to Hono.

2.3. **Token validator.** Add `services/oauth/token-validator.ts` with the `OAuthTokenValidator` `WorkerEntrypoint`. Export it from `apps/api/src/index.ts`. Spec 6.2.

2.4. **Authorize handler.** Add `services/oauth/authorize-handler.ts` and the `GET /oauth/authorize` route. Spec 6.5 steps 1 to 4.

- Tests: a bad client shows an error page with no redirect, an `AuthorizationError` with `redirectTo` redirects, a good request stores a pending consent and redirects to the web consent URL.

2.5. **Consent service and routes.** Add `services/oauth/consent-service.ts` and `routes/agent-access.ts` with `GET /agent-access/consents/:id`, `POST .../approve`, `POST .../deny`. Spec 6.5 steps 6 to 9 and the rules.

- Tests: no session gives `401`, a bad origin gives `403`, single use, the scope subset rule, project ownership, the props shape.

2.6. **Grants.** Add `services/oauth/grants-service.ts`, `GET /agent-access/grants`, and `DELETE /agent-access/grants/:grantId`. Spec 6.7.

2.7. **Cron.** Add `purgeExpiredData` with a saved cursor to the `scheduled` handler. Spec 6.7.

2.8. **Login redirect.** Add `validateSearch` and the redirect sanitizer to `routes/login.tsx`. Pass the path to `signIn` and to `<Navigate>`. Spec 6.6.

- Tests: the open-redirect cases.

2.9. **Consent page.** Add `routes/oauth/consent.tsx`, `components/oauth/consent-page.tsx`, `lib/agent-access-api.ts`, and `lib/queries/agent-access.ts`. Add the `frame-ancestors 'none'` header for this route. Spec 12.1.

2.10. **Connected agents.** Add `ConnectedAgentsSection` to `settings-page.tsx`. Spec 12.2.

2.11. **Local dev.** Add the local `OAUTH_KV` binding to `apps/api/wrangler.json`. Add `OAUTH_ISSUER` and `MCP_RESOURCE_URL` vars. Add `/oauth`, `/.well-known`, and `/agent-access` to the tunnel path lists.

2.12. **Docs.** Start `docs/current/mcp-server.md` with the auth section.

### Exit criteria

- With MCP Inspector, a local agent completes the full OAuth flow and gets a token. The token validates through `OAuthTokenValidator`.
- The user sees the grant in "Connected agents" and can revoke it. A revoked token fails validation.
- Phase checks pass. `pnpm --filter @doxahq/web build` passes.

### Approval points

- Editing `apps/api/wrangler.json` (local bindings and vars).
- Creating the production `OAUTH_KV` namespace and adding it to the production config. Do this only in Phase 6, or when the user asks.

---

## Phase 3: MCP Worker, tool framework, read tools

**Goal:** an agent can connect and read Doxa data.

### Tasks

3.1. **Worker entry and config.** Add `apps/api/src/mcp.ts`, `apps/api/wrangler.mcp.json` (local values only), and the `McpEnv` type. Spec 9.1, 17.

3.2. **Local dev token stub.** When `MCP_DEV_AUTH_BYPASS` is `"true"` and the request is from localhost, accept a fake `ctx.auth` from a local header. The production config validator must reject this var.

3.3. **Framework.** Add `mcp/request-context.ts`, `server.ts`, `tool-definition.ts`, `tool-runner.ts`, `errors.ts`, `scope-precheck.ts`, `rate-limit.ts`, `activity.ts`. Spec 9.2 to 9.6.

- Tests: `mapToolError` for each row of spec 9.6. The scope pre-check returns `403` with the full scope set. `runTool` order: scope, limit, run, output check, audit.

3.4. **Activity table.** Add `agent_activity` to `packages/db/src/schema/doxa.ts` and generate migration `0026`. Add `repositories/agent-activity.ts`. Spec 11.2.

- Tests: schema shape with `getTableConfig`.

3.5. **Read tools.** `get_account`, `list_projects`, `get_project`, `list_github_repositories`, `get_docs_structure`, `read_page`, `search_docs`, `list_branches`, `get_branch_status`, `get_site_settings`, `list_publications`, `list_domains`, `get_generation`. Spec 9.7.

- Tests: for each tool, success, another user's project (`not_found`), a project outside the grant (`project_not_in_grant`), and a missing scope.

3.6. **Resources.** `doxa://projects/{projectId}/pages/{+href}` and `doxa://schemas/site-config`. Spec 9.9.

3.7. **Registry tests.** Tool names, scopes, and import boundaries. Spec 18.2.

3.8. **Dev env.** Start `doxa-mcp` on port 8791 (inspector 9233) from `scripts/dev-env.sh`. Add the MCP host to the tunnel config.

3.9. **Docs.** Add the tools and local dev sections to `docs/current/mcp-server.md`.

### Exit criteria

- MCP Inspector and Claude Code connect to the local server with a real token from Phase 2 and call each read tool.
- A 2025-style client works through the legacy lane.
- Phase checks pass.

### Approval points

- Running migration `0026` against the local database (`pnpm db:local:migrate`). Running it against production waits for Phase 6.
- Editing `scripts/dev-env.sh` and the tunnel scripts.

---

## Phase 4: Write tools

**Goal:** an agent can create branches, edit docs, change site settings, and build previews.

### Tasks

4.1. **Branch tools.** `create_branch` and `sync_branch` (with `dryRun`). Spec 9.7.

- Tests: name rules, `branch_limit_reached` with the hint, dry run versus apply.

4.2. **Docs write tools.** `write_page` and `edit_docs`. Named branches only. The MDX check, `expectedRevision`, and `dryRun`. Spec 9.7, 10.2, 10.6.

- Tests: `"main"` rejected with the hint, MDX error returns `mdx_invalid` and writes nothing, revision conflict, dry run writes nothing, the edit origin is `"mcp"`.

4.3. **Site settings tool.** `update_site_settings` with `replace` and `merge_patch`. Add the pure merge patch helper. Spec 9.7.

- Tests: RFC 7396 examples, invalid result returns `validation_failed` with issues, the `poweredBy` entitlement rule, asset references.

4.4. **Preview tool.** `build_preview`. Spec 9.7.

- Tests: success, `preview_rate_limited`.

4.5. **MDX reference resource.** Find the component guidance in `packages/agent` that the generation writer uses. Build `doxa://reference/mdx` from it and from `RUNTIME_MDX_COMPONENT_NAMES`. Do not write a second copy. Spec 9.9.

4.6. **Server instructions.** Write the workflow text of spec 9.2.

4.7. **Docs.** Update `docs/current/mcp-server.md`.

### Exit criteria

- With Claude Code, an agent creates a branch, edits two pages, changes the site theme with a merge patch, and builds a preview. The dashboard shows the branch and the changes.
- Phase checks pass. The three artifact compatibility suites pass.

### Approval points

- None.

---

## Phase 5: Agent actions and approvals

**Goal:** consequential actions run through the gateway, and gated actions wait for a dashboard decision.

Do the tasks in this order. Tasks 5.1 to 5.9 with `docs.publish` only form the MVP cut.

### Tasks

5.1. **Contracts.** Add `packages/contracts/src/approval-requests.ts`: the status enum, request DTOs, `ActionToolOutput`. Add the `./approval-requests` export.

5.2. **Tables.** Add `agent_approval_requests`, the publication columns, and the foreign key on `agent_activity`. Generate migration `0027`. Add `repositories/agent-approval-requests.ts` with a store interface and an in-memory test store. Spec 10.4, 11.1.

- Tests: schema shape. The partial unique index exists.

5.3. **Action types and registry.** Add `agent-actions/action-definition.ts` and `registry.ts`. Spec 8.1, 8.2.

5.4. **Approval policy.** Add `policy/approval-policy.ts` and `policy/platform-overrides.ts`. Spec 8.4.

- Tests: spec 18.1 resolver cases.

5.5. **Publish action.** Add `actions/docs-publish.ts`. Add `attribution` to `DocsBranchPublish.publish`. Spec 8.3, 8.8, 10.4.

5.6. **Gateway and approval service.** Add `gateway.ts` and `approval-service.ts`, with the cron sweeps in the `scheduled` handler. Spec 8.5 to 8.7.

- Tests: spec 18.3 gateway and approval service cases.

5.7. **RPC and tools.** Add `agent-actions/rpc.ts` with `AgentActionsApi`. Export it from `apps/api/src/index.ts`. Add `publish_branch`, `get_approval_request`, `list_approval_requests`, and `cancel_approval_request`. Spec 9.7, 9.8.

- Tests: an MCP test from tool call to a pending request, then approve, then a completed request.

5.8. **Approval routes.** Add `routes/approval-requests.ts`: `GET /approval-requests/:id`, `GET /projects/:id/approval-requests`, `GET .../:rid`, `POST .../:rid/approve` (JSON or SSE), `POST .../:rid/reject`. Spec 8.7.

- Tests: spec 18.5 approval route cases.

5.9. **Dashboard: publish approval.** Add the approval resolver route, the `validateSearch` on `content.tsx`, the `"approval"` view in `PublishMenu`, the per-page diff, and the pending-request banner. Add attribution to the history panel. Spec 12.3, 12.4.

5.10. **Other actions.** Add `docs.restore`, `domain.add`, `domain.remove`, `project.create`, `project.delete`, and `generation.start`, with their tools: `restore_publication`, `add_domain`, `check_domain`, `remove_domain`, `create_project`, `delete_project`, `start_generation`, `cancel_generation`. Spec 8.3, 8.8, 9.7.

- Tests: for each action, allow, require approval, freshness, and execution. `project.delete` rejects `allow` from any source.

5.11. **Dashboard: approval pages.** Add the "Requests" sidebar item with the count, the requests table, and the approval page with the typed confirmation. Add the exhaustive review renderer map. Spec 12.5.

5.12. **Docs.** Add `docs/current/agent-actions.md` with the extensibility recipes. Update `docs/current/docs-branching.md` (spec 10.7).

### Exit criteria

- With Claude Code, an agent calls `publish_branch` and gets an approval link. The user opens the link, sees the publish menu in the approval state, and approves. The agent polls and gets `completed` with the live URL.
- A rejected request returns the reason to the agent. An edit after the request makes the request stale.
- Changing `docs.publish` to `"allow"` in its module makes `publish_branch` publish at once, with no other code change. Revert after the check.
- Phase checks pass. `pnpm --filter @doxahq/web build` passes. The three artifact compatibility suites pass.

### Approval points

- Running migration `0027` against the local database.

---

## Phase 6: Hardening and launch

**Goal:** production readiness.

### Tasks

6.1. **Production config.** Complete `apps/api/wrangler.mcp.json` for production. Add the MCP checks to `scripts/validate-production-config.mjs` and fixtures to its tests. Add `deploy:mcp`. Spec 17.

6.2. **Load test.** Write a test-agent script. Run it against staging with the targets of spec 13.3. Record the results.

6.3. **Security review.** Review the OAuth flow, the consent page, the login redirect, the approval routes, and the RPC entrypoints against spec 14. Use the `security-review` skill and a second reviewer. Fix every finding.

6.4. **Client checks.** Run spec 18.7 with every client on staging.

6.5. **URL elicitation hint.** For clients that support it, return `inputRequired.elicitUrl` with the approval link, in addition to the normal result. Spec 9.8.

6.6. **Documentation.** Finish `docs/current/mcp-server.md` (runbook, limits, rollback). Update `docs/diagrams/high-level-system.mmd`, `docs/diagrams/README.md`, `AGENTS.md`, and `docs/testing-strategy.md`. Write the client connection guides for the official docs site. Spec 19.

6.7. **Rollout.** In this order, each with approval:

1. Create the production `OAUTH_KV` namespace.
2. Run migrations `0026` and `0027` in production.
3. Deploy `doxa-api` with the authorization server and the RPC entrypoints.
4. Deploy `doxa-mcp` and bind `mcp.doxa.so`.
5. Connect one internal client and run the main workflow.
6. Announce.

**Rollback:** remove the `mcp.doxa.so` route, or deploy `doxa-mcp` with a handler that returns `503`. The dashboard does not depend on `doxa-mcp`. Pending approval requests stay valid.

### Exit criteria

- The load test meets the targets.
- The security review has no open findings.
- Every client in spec 18.7 completes the main workflow on staging.
- `pnpm test` and `pnpm typecheck` pass at the root.

### Approval points

- Every item in 6.7.
- The staging deployment and the load test cost.
- Production Wrangler config changes and the deploy workflow change.

---

## Risks

| Risk | Effect | Response |
|---|---|---|
| The Workers OAuth Provider v1 is new (1.0.0 on 2026-09-24). | Bugs or API changes. | Pin an exact version. Phase 0 proves the integration. Read the changelog before each upgrade. |
| `agents` pins SDK 2.0.0. | No per-tool `scopeChallenge`. | Header pre-check (spec 9.4). Revisit when `agents` moves. |
| Client support for the 2026 protocol varies. | Some clients use the legacy lane, with no elicitation. | The approval flow does not need elicitation. Phase 0 and 6.4 test real clients. |
| Agents write MDX that renders badly but parses. | Ugly pages after publish. | The approval review, the preview tool, and the MDX reference resource. |
| The branch limit (10 for each site) blocks agents. | `branch_limit_reached`. | The hint lists the branches. Agents reuse branches. Raise the entitlement later if needed. |
| Hyperdrive connection limits under load. | Errors at peak. | One pool for each request, rate limits, the load test. |
