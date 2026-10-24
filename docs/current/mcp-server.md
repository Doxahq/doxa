# MCP server

## Purpose

The `doxa-mcp` Worker serves a remote MCP server. A user connects an MCP client
(Claude, Cursor, ChatGPT, or a custom agent) to Doxa. The agent then runs docs
workflows for that user, inside the projects that the user picked.

The design is in `docs/superpowers/specs/2026-10-04-mcp-server-design.md`.
Consequential actions and approvals are in [agent-actions.md](agent-actions.md).

## Architecture

- `doxa-mcp` is the `apps/mcp` package (`@doxahq/mcp`): entrypoint
  `src/index.ts`, config `wrangler.json`. It imports `apps/api` services
  through the `exports` map in `apps/api/package.json`. Add a subpath there
  when the MCP Worker needs another API module. It is stateless. It uses `createMcpHandler` from
  `agents/mcp/server` (0.26.0) with `@modelcontextprotocol/server` and
  `@modelcontextprotocol/client` 2.3.1. `agents` pins 2.0.0 as a peer; pnpm
  resolves it to 2.3.1, and `agents` only wraps the SDK's `createMcpHandler`.
  It has no Durable Objects.
- MCP 2026-07-28 requests and 2025 requests (`legacy: "stateless"`) both work.
- `OAuthResourceServer` checks each token over the `AUTH_SERVER` service binding
  (`OAuthTokenValidator` in `doxa-api`). Token checks read `OAUTH_KV`, never
  Postgres.
- Reads and branch writes call the `apps/api` services in the Worker. Each
  request opens one database pool (`createRequestDbScope`).
- Consequential actions call `PLATFORM_ACTIONS` (`AgentActionsApi` in
  `doxa-api`). The MCP Worker holds no secrets, no queue producer, no cache
  invalidator, and no Cloudflare or GitHub credentials.

## Sign-in

- `doxa-api` runs `OAuthAuthorizationServer` (Workers OAuth Provider 1.2.1).
  Issuer: `OAUTH_ISSUER`. Resource: `MCP_RESOURCE_URL`.
- Provider paths: `/.well-known/oauth-authorization-server`, `/oauth/token`
  (also revocation), `/oauth/register`. They run before the Hono middleware.
- `GET /oauth/authorize` checks the client, stores a pending consent for 10
  minutes, and redirects to the consent page `/oauth/consent` in `apps/web`.
- The consent page reads the Better Auth session. The user picks scopes and
  projects (all projects, or a list). The consent is single use.
- The project picker groups projects by team. Team projects the user can
  read are valid picks.
- Users see and revoke grants in Settings, under "Connected agents".
- Access tokens last 1 hour. Refresh tokens last 30 days, or 14 days without
  use.

## Scopes

| Scope | Lets the agent | Implies |
|---|---|---|
| `projects:read` | List and read projects, domains, generations | — |
| `projects:write` | Create and delete projects | `projects:read` |
| `docs:read` | Read and search pages, settings, branches, history | — |
| `docs:write` | Create branches, edit docs, upload images, build previews | `docs:read` |
| `site:write` | Change site settings on a branch | `docs:read` |
| `domains:write` | Add, check, and remove custom domains | `projects:read` |
| `publish` | Publish branches, restore publications | `docs:read` |
| `generation:run` | Start and cancel generations | `projects:read` |

See [Protocol](#protocol) for what a client gets when the token lacks a scope.

## Teams

- Tools authorize through `MembershipProjectAccessPolicy`: a team project
  works for members by role ([teams.md](teams.md)). A role denial reads as
  `not_found`, so a viewer's agent can read and its writes answer "not found".
- `list_projects` includes team projects, each with `team`. `get_account`
  returns `teams: [{ id, name, role }]`.
- Services still take the project owner's user ID (`authorized.ownerUserId`).

## Tools

34 tools in all (`TOOLS` in `apps/mcp/src/tools/index.ts`; the registry test
checks the count).

- Account and projects: `get_account`, `list_projects`, `get_project`,
  `list_github_repositories`, `create_project`, `delete_project`.
- Docs: `get_docs_structure`, `read_page`, `search_docs`, `write_page`,
  `edit_docs`, `upload_asset`.
- Branches: `list_branches`, `create_branch`, `get_branch_status`,
  `get_branch_diff`, `sync_branch`, `build_preview`, `delete_branch`.
- Site settings: `get_site_settings`, `update_site_settings`.
- Publish and history: `publish_branch`, `list_publications`,
  `restore_publication`.
- Approval requests: `get_approval_request`, `list_approval_requests`,
  `cancel_approval_request`.
- Domains: `list_domains`, `add_domain`, `check_domain`, `remove_domain`.
- Generation: `start_generation`, `get_generation`, `cancel_generation`.

Rules:

- On `main`, read tools show the live site. They never show the user's
  unpublished drafts.
- Write tools need a named branch. `"main"` is rejected with a hint to call
  `create_branch`.
- Write tools check each page with the renderer's MDX parser before the write,
  and accept `expectedRevision`.
- `edit_docs` `create_group` adds only the heading, with no placeholder page.
  To give the group its first page in the same call, follow it with a
  `create_page` whose `groupIndex` is the new group's index. The group indexes
  count every heading in the section, and `get_docs_structure` lists empty
  groups with `hrefs: []`. The dashboard sends `starterPage: true` to keep its
  "New Page"; the MCP schema leaves that field out.
- `create_branch` stores the calling OAuth client and the member it acts for
  on the branch (`docs_branches.created_by_client_id`,
  `created_by_client_name`, `created_by_user_id`; the name is a snapshot
  because the MCP Worker cannot read the client registry). The user is the
  MCP requester, not `owner_user_id`, which is the project owner in a team
  project. `list_branches` shows `createdBy`: `{ kind: "user" }` for a
  dashboard branch, or `{ kind: "agent", clientName, isCaller }`. `isCaller`
  is true only when both the client ID and the user ID match the caller.
  The client ID is not shown to agents.
- `delete_branch` (`docs:write`, destructive) deletes only a branch that the
  same OAuth client created for the same member. Team members can share a
  client ID, so a teammate's agent branch answers `branch_not_found`, as does
  every other branch. A branch whose creator account was deleted
  (`created_by_user_id` set null) has no agent that may delete it. A branch
  with a pending publish request fails with `publish_pending` and
  `details.requestId`: cancel it with `cancel_approval_request` first. No
  approval gate. It reuses `DocsBranchManagement` (`eraseOwnedByAgent`).
- `get_branch_diff` (`docs:read`) returns the added, edited, and deleted
  pages (href, title), structure files (manifest, sections, navigation), and
  site settings, each with a unified diff against the branch base, cut after
  200 lines (`truncated`, `lineCount`). `behind` says main moved on since the
  base. The dashboard reads the same `DocsBranchDiffService` through `GET
  /projects/:projectId/branches/:branchRef/diff`.
- `search_docs` takes an optional `branch`. With a branch ID, the changed
  pages of the branch (from `docs_branch_changes`, at most 500 pages or 2 MB
  of MDX, in path order) replace their live entries in one MiniSearch index
  built with the live tokenizer and ranking; pages the branch deleted, and
  changed pages past a limit, are left out. Results carry `status`
  (`edited` or `published`), plus `truncated` and `truncatedReason`
  (`page_limit` or `size_limit`). Branch engines are cached per isolate by
  branch revision and main version.
- `upload_asset` (`docs:write`, cost `expensive`) adds an image to a named
  branch. Input: `branch`, `fileName`, `contentBase64`, optional `altText`.
  Output: `path` (for example `/assets/rate-limits-diagram.png`), a
  `markdown` image line, `contentType`, `size`, `sanitized`, `reused`, and
  the new `revision`. See [Branch images](#branch-images).
- `get_branch_diff` lists the images of the branch in `assets` (`path`,
  `change`, `contentType`, `size`). Images have no text diff.
- Action tools return `{ outcome: "completed", result }` or
  `{ outcome: "approval_required", request, message }`, whatever the policy.
  A client that declares MCP Tasks gets a task for an `approval_required`
  outcome instead; see [Protocol](#protocol).
- The mode of each action comes from, in order: platform overrides, the
  project setting, the user setting, the action default. Users set the modes
  on the Agent approvals pages; see `docs/current/agent-actions.md`. A blocked
  action fails with `action_denied`. A pending request that a setting blocks
  later becomes `cancelled` with the error code `blocked`.
- Approval request DTOs (`get_approval_request`, `list_approval_requests`)
  carry `policySource`: why the gate applied.
- `publish_branch` fails with `mdx_invalid` while a changed page of the branch
  fails the MDX check (v2 spec 8.1). The message names each page (href, source
  path, line, reason; five pages, then "and N more"), and the hint says to fix
  them with `read_page` and `write_page`. See [MDX check](#mdx-check).

## MDX check

`checkMdxSource` (`src/services/docs-content/mdx-check.ts`) runs the
renderer's parser on one page source. The parser names an unknown component
without a position, so the check reports the first use of the tag outside a
code fence. `page-mdx-issues.ts` in the same folder adapts it for the other
callers:

- Agent writes (`write_page`, `edit_docs`) refuse a page that fails the check,
  as in v1.
- Dashboard saves (`POST /projects/:projectId/content/edits`) always write.
  The response is `{ working, mdxIssues }`: the saved pages that fail the
  check, each with `href`, `sourcePath`, and `issues` (`line`, `column`,
  `message`; the line counts frontmatter). The editor shows the open page's
  issues under the page.
- Publish is blocked while a changed page fails the check. The issues are
  computed on demand from the branch changes (`branchMdxIssues`): only
  upserted `source/**.mdx` paths, in path order. Unchanged pages are live
  already and are not checked. No issue state is stored, so the report and
  the publish never disagree, and the cost is one parse per changed page
  (a branch holds at most a few hundred changes).
  - `GET /projects/:projectId/content/mdx-issues?branch=` returns
    `{ pages }`; the publish menu lists those pages and disables Publish.
  - `DocsBranchPublish.publish` (dashboard publish of a named branch or of
    main's drafts, and an approved or allowed `docs.publish` action) throws
    `mdx_invalid` (HTTP 422, `details.pages`) before it builds anything.
  - The `docs.publish` action also checks in `capture`, so no approval
    request starts for a branch that cannot go live. The snapshot pins the
    revision, so a later edit makes the request stale; `execute` checks
    again through `DocsBranchPublish`.

## Prompts

The server advertises `prompts` and registers four prompts
(`PROMPTS` in `apps/mcp/src/prompts/index.ts`, v2 spec 8.2). Each one returns
one user message with the steps and the exact tool names in backticks. The
prompt text lives in one module per prompt; `workflow-text.ts` holds the
shared rules (named branch only, `expectedRevision`, scopes, approval flow,
error hints). The SDK validates the arguments with each prompt's Zod schema.
MCP sends prompt arguments as strings.

| Prompt | Arguments | Workflow |
|---|---|---|
| `write_guide` | `projectId`, optional `topic`, `audience` | Find the place and duplicates, create a branch, `create_page`, write it, diff, preview, publish. |
| `update_from_code_change` | `projectId`, `change` (diff or PR summary, at most 80,000 characters) | List reader-visible changes, search and read the pages, update them on a branch, search the branch for old names, diff, preview, publish. |
| `review_branch` | `projectId`, `branchId` | Status and sync dry run, diff, MDX check with an `edit_docs` dry run, links against `get_docs_structure`, style, report. |
| `fix_broken_links` | `projectId`, optional `branchId` | Valid hrefs from `get_docs_structure`, links from `read_page`, targets from `search_docs`, fixes with `write_page` on the given or a new branch. |

Prompts call nothing, so they need no scope; the tools they name check their
own scopes and the approval policy. The user's diff is quoted in a fence that
it cannot close and marked as data. Doxa has no link checker tool;
`fix_broken_links` describes the manual check. The tests list the prompts
with the SDK client, check that every backticked name is a registered tool,
and check argument validation.

## Branch images

`DocsBranchAssetUpload` in `src/services/docs-branches/assets/` runs the
upload. The image is a branch change, so it goes live only with the next
approved publish of the branch. `build_preview` shows it too.

- Type: from the bytes, never from the file name. PNG, JPEG, WebP, and GIF
  by their signatures. Any other file must be UTF-8 SVG text that parses as
  XML; anything else fails with `asset_invalid`.
- SVG: the site asset allowlist (`cleanSvg` in
  `src/services/site-assets/svg.ts`, built on `@xmldom/xmldom`) with the
  `docs_image` profile, which adds diagram elements (`marker`, `pattern`,
  `textPath`) and presentation attributes. It removes scripts, `on*`
  attributes, `foreignObject`, every `href` that is not a `#fragment`
  (`javascript:` URLs, external `use` and `image`), styles with `@import`,
  `url()` or escapes, DOCTYPE and entities, and processing instructions such
  as `xml-stylesheet`. `sanitized: true` means it removed one of these.
  Comments and namespace declarations do not count.
- Size: 5 MB decoded (`asset_too_large`). The MCP body limit is 8 MiB, so the
  base64 of the largest image fits.
- Names: the file name becomes a lowercase slug with the extension of the
  detected type (`Rate Limits.PNG` with JPEG bytes becomes
  `rate-limits.jpg`). A new upload never replaces a file: a name that the
  branch or its base already has gets `-2`, `-3`, and so on. The same bytes
  under a name the branch already has return that path with `reused: true`
  and write nothing.
- Quota: 50 images on one branch (`asset_limit_reached`). The base version
  size plus the branch images plus the new file must fit the plan storage
  (`storage_quota_exceeded`, free plan 100 MiB, `FREE_PLAN_STORAGE_LIMITS`).
- Storage: the upload writes a one-file version folder with the version tree
  writer, then a branch change at `assets/{name}` whose content is a pointer
  to that folder (`asset-pointer.ts`). Publish and preview copy the tree
  entry into the new version; no image byte is read again. See
  `docs/current/docs-content-storage.md`.
- Serving: `/assets/{name}` on the docs host serves the image of the
  served version; see `docs/current/production-docs-rendering.md`.
- Sync keeps the branch image. Delete, erase, and publish remove the change
  rows; the `docs_branch_asset_folder` collector then removes the upload
  folder.
- The dashboard editor does not show branch images yet: its preview has no
  route for them.

Resources: `doxa://projects/{projectId}/pages/{+href}`,
`doxa://schemas/site-config`, `doxa://reference/mdx`.

## Protocol

### Scope step-up

- On a 2026-07-28 request, each tool with a scope carries the SDK's
  `scopeChallenge` (`apps/mcp/src/scope-challenge.ts`, SDK 2.1+). The SDK runs it
  on the parsed `tools/call`, before the tool, and answers `403` with
  `WWW-Authenticate: Bearer error="insufficient_scope",
  error_description="This tool needs the <scope> scope.", scope="<scope>",
  resource_metadata="..."`. The challenge names only the missing scope; the SDK
  client adds it to the scopes it holds and asks the user for that one.
  Implied scopes count (`publish` grants `docs:read`).
- A 2025 request gets no challenge: the tool runner returns the tool error
  `insufficient_scope`, as in v1, which a client without step-up can show.
  The runner check also stays for 2026 requests as a second line.
- v1 read the `Mcp-Method` and `Mcp-Name` headers in `scope-precheck.ts` and
  asked for the full scope set. That file is gone.

### MCP Tasks for gated actions

- Doxa implements the Tasks extension (SEP-2663,
  `io.modelcontextprotocol/tasks`) on 2026-07-28 servers only. The SDK
  serves `tasks/get` and `tasks/cancel` for it (2.3+) but has no task
  runtime, so `apps/mcp/src/tasks/` builds each task from an approval request.
- 2026 servers advertise `extensions: { "io.modelcontextprotocol/tasks": {} }`.
  A `tools/call` that declares the extension in its per-request client
  capabilities, and whose action tool returns `approval_required`, gets a
  `CreateTaskResult` (`resultType: "task"`). The result keeps the v1
  `content` and `structuredContent`: the SDK checks them against the tool's
  output schema, and Tasks clients ignore them.
- The task ID is the approval request ID. The approval row is the durable
  task state: no new table, nothing in memory. Before it answers, the Worker
  reads the request back through the new `getRequestTask` RPC of
  `AgentActionsApi` (the request plus its approval link). If that read fails,
  the call returns the v1 result and logs `mcp_task_create_failed`.
- `tasks/get` maps the request status:

  | Request | Task |
  |---|---|
  | `pending` | `input_required`, `inputRequests.approval` is a URL elicitation with the approval link |
  | `executing` | `working` |
  | `completed` | `completed`, `result` is the tool result `{ outcome: "completed", result }` |
  | `rejected`, `expired`, `stale`, `failed` | `completed` with a tool error: `request_rejected` (with the note), `request_expired`, `stale`, `action_failed` |
  | `cancelled` | `cancelled` |

  The extension keeps `failed` for JSON-RPC errors, so a refused action is a
  tool error inside `completed`. `ttlMs` is null (rows are kept);
  `pollIntervalMs` is 10 seconds.
- `tasks/update` acknowledges and ignores the responses: the person decides
  in the dashboard. The `approval` input request stays the same while the
  request is pending, so clients show it once.
- `tasks/cancel` cancels a pending request. For a request that already ended
  it acknowledges and changes nothing (cancellation is cooperative).
- Every `tasks/*` call needs the extension in the request's capabilities
  (`-32021` otherwise) and reads the request through `doxa-api`, which serves
  only the calling client's requests. An unknown or foreign ID answers
  `-32602`. `tasks/get` and `tasks/update` count as `read`, `tasks/cancel` as
  `write`.
- Clients without Tasks, and every 2025 client, keep the v1 union and poll
  `get_approval_request`. The SDK has no runtime for the 2025-11-25 core
  Tasks (`params.task`, `tasks/result`), so Doxa does not serve them.
- Deploy `doxa-api` before `doxa-mcp`: the MCP Worker calls the new RPC
  method.

## Limits

| Tool cost | Key | Requests for each 60 seconds |
|---|---|---|
| read | user and client | 600 |
| write | user and client | 120 |
| expensive | user | 20 |

The request body limit is 8 MiB (it was 4 MiB in v1; `upload_asset` needs
more). Rate limits count per Cloudflare location.

## Errors and logs

- Every tool error has `code`, `message`, an optional `hint`, optional `issues`,
  and `requestId`. `mapToolError` in `apps/mcp/src/errors.ts` is the only mapper.
- Each tool call logs one JSON line without tokens, props, or content.
- Writes, actions, decisions, and approval setting changes add a row to
  `agent_activity`.

## Local development

1. Run migrations `0026` to `0029` on the local database.
2. Run `pnpm dev`. It starts the MCP Worker on port 8791 (inspector 9233)
   after the API. Use `--no-mcp` (or `DOXA_DEV_NO_MCP=1`) to skip it.
3. To run the MCP Worker alone, start the API first, then run
   `pnpm --filter @doxahq/mcp dev`.
4. Connect MCP Inspector to `http://localhost:8791/mcp`.

Local dev only: with `MCP_DEV_AUTH_BYPASS=true`, a request from localhost can
send `x-doxa-dev-user-id` and `x-doxa-dev-scopes` instead of a token.

## Production

- The Worker is `doxa-mcp-production` (`env.production` in
  `apps/mcp/wrangler.json`). It serves `https://mcp.doxa.so/mcp` as a Worker
  custom domain, so Wrangler creates the DNS record and certificate.
- `AUTH_SERVER` and `PLATFORM_ACTIONS` bind to `doxa-api-production`. The
  Worker uses the production Hyperdrive configs and `doxa-docs-artifacts-enam`.
- `MCP_DEV_AUTH_BYPASS` is `"false"` in production.
- `doxa-api-production` runs the OAuth server: `OAUTH_ISSUER` is
  `https://api.doxa.so`, `MCP_RESOURCE_URL` is `https://mcp.doxa.so/mcp`, and
  grants and tokens live in the `OAUTH_KV` namespace.
- `pnpm validate:production-config` checks these rules
  (`scripts/lib/mcp-production-config.mjs`):
  - the bypass is off;
  - no var points to localhost;
  - both bindings target `doxa-api-production`;
  - the resource host is the custom domain;
  - the API and the MCP Worker agree on the issuer and the resource;
  - the API binds `OAUTH_KV`.
- Deploy with `pnpm deploy:all` or the Deploy Production workflow (in the ops repo). The `mcp`
  step runs after the API, because the Worker calls API entrypoints such as
  `getRequestTask`. To deploy it alone, run `pnpm deploy:all --step mcp`.

## Related files

- `apps/mcp/` (Worker, tests, `wrangler.json`)
- `scripts/deploy-production.mjs`, `scripts/lib/mcp-production-config.mjs`
- `apps/api/src/services/oauth/`, `apps/api/src/routes/agent-access.ts`
- `apps/api/src/services/agent-access/`
- `apps/web/src/routes/oauth/consent.tsx`,
  `apps/web/src/components/dashboard/settings/connected-agents-section.tsx`
