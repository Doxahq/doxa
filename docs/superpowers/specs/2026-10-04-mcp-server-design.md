# Doxa MCP server

Status: design approved in conversation, not implemented.
Date: 2026-10-04.
Decision: A separate stateless Worker, `doxa-mcp`, serves a remote MCP server at `https://mcp.doxa.so/mcp`. Workers OAuth Provider v1 issues the agent tokens. Better Auth stays the login system. Consequential agent actions go through one action gateway with a configurable approval policy.

The implementation plan is `docs/superpowers/plans/2026-10-04-mcp-server.md`.

Follow the project clean-code skill (`i-coderone-clean-code`) and the repository instructions in `AGENTS.md`. Security, correctness under concurrency, extensibility of the approval policy, and clean code are acceptance criteria in this spec, not optional polish.

This handoff describes implementation work. It does not authorize a commit, a deployment, a migration run, a new KV namespace, a DNS change, or a Wrangler production config change. Get explicit approval for each of these.

Doxa has no customers yet. Downtime between phases is acceptable.

## 1. Goal and scope

Let a user connect any MCP client (Claude, Cursor, ChatGPT, custom agents) to Doxa. The agent then runs Doxa docs workflows for that user.

- The agent signs in through OAuth. The user approves the agent once, on a consent page.
- The user picks the projects that the agent can use, or gives access to all projects.
- The agent can list projects, read docs, search docs, create projects, edit docs on branches, change site settings, build previews, and manage domains.
- Consequential actions go through an approval policy. A gated action waits for a human decision in the dashboard.
- The approval policy is data in code, not logic in each tool. A developer can add, remove, or relax a gate with a one-line change. Later, a project setting or a user setting can change a gate with no refactor.
- The design is ready for teams. Today each project has one owner. The access layer, the approval records, and the policy sources do not assume this.

### In scope

- The `doxa-mcp` Worker: Streamable HTTP, stateless, MCP 2026-07-28, with a compatibility lane for 2025 clients.
- The OAuth authorization server in `doxa-api`, the consent page, and the "Connected agents" settings.
- The access layer: actor, capabilities, scopes, and one project access policy.
- The agent action gateway, the action registry, the approval policy resolver, and the approval request lifecycle.
- About 30 MCP tools, three resources, and the error model for tools.
- Changes to current services: server-side edit origin, optimistic revision for edits, extraction of the generation start, publication attribution, and one database pool for each MCP request.
- The dashboard: consent page, connected agents, approval requests list, approval state in the publish menu, and an approval page for the other actions.
- Rate limits, an agent activity log, tests, and documentation.

### Explicit exclusions

- NO teams, members, or roles. Section 7.6 lists the seams that make them a later, additive change.
- NO user or project settings UI for the approval policy. Section 8.9 defines the seam and the planned table.
- NO personal access tokens for headless agents. This is a follow-up (section 21).
- NO MCP Tasks extension. The MCP TypeScript SDK v2 does not support it yet. Agents poll an approval request with a tool.
- NO Durable Objects. NO `McpAgent`. Cloudflare deprecated it.
- NO site asset upload for agents. Agents can reference assets that exist.
- NO change to the renderer, the docs runtime, the artifact schema, or the generation pipeline.
- NO change to the Better Auth configuration.

## 2. Repository facts

These facts were checked in the code on 2026-10-04.

| Fact | Location |
|---|---|
| Login is cookie only. Better Auth runs with `plugins: []`, after the `withCloudflare` spread. `getSessionUser` reads only the session cookie. | `packages/auth/src/server.ts:116`, `packages/auth/src/session.ts:11` |
| No route accepts a bearer token. There are no API keys, no OAuth server tables, and no `apikey` table. | `packages/db/src/schema/auth.ts` |
| CSRF rejects a mutation with no trusted `Origin`. Exemptions: `/api/auth`, `/internal`, `/github/webhook`. | `apps/api/src/http/csrf.ts:5-7` |
| CORS allows only `WEB_ORIGIN`. | `apps/api/src/http/middleware.ts:15-46` |
| `withUser` passes only a `userId` string to a handler. | `apps/api/src/http/auth.ts:12` |
| The client sends the edit origin (`editor`, `agent`, `mcp`) in the request body. The route passes it to the service. | `packages/contracts/src/docs-content.ts:19,270-276`, `apps/api/src/routes/docs-content.ts:64` |
| Only `erase` and `discard` check the origin. `publish` and `restore` take no origin. | `services/docs-branches/branch-service.ts:109`, `management.ts:117`, `publish.ts:70`, `history.ts:52` |
| The branching contract says that agent and MCP origins cannot erase, publish, or restore. | `docs/current/docs-branching.md:199-200` |
| Every ownership check is a SQL join on `projects.userId = $userId`, repeated in about 15 repository queries. There is no shared access helper. | `repositories/projects.ts:89`, `docs-branch-resolution.ts:37`, and others |
| `projects.userId` is the only owner column. There are no team, member, or role tables. | `packages/db/src/schema/doxa.ts:206-208` |
| Services are classes with `static fromEnv(env)` and plain inputs (`userId`, `projectId`, branch ref). None takes a Hono context. | `services/docs-content/service.ts:65`, `services/docs-branches/*.ts` |
| A second Worker entrypoint already shares the API repositories. | `apps/api/src/docs-resolver.ts`, `apps/api/wrangler.docs-resolver.json` |
| `applyEdits` reads the revision itself and retries up to 5 times. A client cannot send an expected revision. | `services/docs-content/service.ts:175-263` |
| Edits on `main` go to the hidden branch of the user. | `repositories/docs-branch-writes.ts:43-53` |
| Publish takes `expectedBaseVersionId` and `expectedRevision`, and fails with `branchChangedSinceReview` when the branch changed. | `services/docs-branches/publish.ts:101-113`, `repositories/docs-branch-publication.ts:28` |
| A branch publication always records `kind: "editor"`. The summary schema is `.strict()`. | `repositories/docs-branch-publication.ts:178-186`, `packages/contracts/src/docs-branches.ts:27-35` |
| Generation start is inline in the route and uses `context.executionCtx.waitUntil`. A generation publishes to production when it completes. | `routes/projects.ts:162-263`, `repositories/docs.ts:446-467` |
| Each `createDb(env)` makes a new `pg` pool (max 5). 25 repository constructors call it. No code closes a pool. | `packages/db/src/client.ts:23-34` |
| The renderer parses MDX with `parseRuntimeMdx` from `@doxahq/mdx-runtime`. It is pure JavaScript and throws on unknown components. The API does not check MDX on save. | `apps/docs-template/src/runtime/runtime-mdx.ts:37`, `packages/mdx-runtime/src/parser.ts:33` |
| The published search index is at `search/index.json` and `search/minisearch.json`. `createSearchEngine` reads it. | `packages/docs-engine/src/index.ts:175-179`, `packages/docs-search/src/index.ts:59` |
| The site config schema has a JSON Schema export. | `packages/site-config/src/json-schema.ts:5` |
| Enums are `pgEnum`. Extensible app values use `text` with a check in app code, for example `docs_branch_changes.origin`. | `packages/db/src/schema/doxa.ts:20-146,469` |
| The next migration number is 0026. | `packages/db/migrations/` |
| The local dev ports in use are 8787 to 8790, 3000 to 3002, 5432, and 9230 to 9232. | `scripts/dev-env.sh:123-139` |
| The dev tunnel sends only listed path prefixes to the API. | `scripts/dev-tunnel.sh:53-77`, `scripts/sync-dev-tunnel-config.mjs:51-61` |
| The login page ignores the `redirect` search parameter. | `apps/web/src/routes/login.tsx:10-20`, `apps/web/src/lib/auth/use-auth-session.ts:52-55` |

### External facts

These facts were checked in the library sources on 2026-10-04.

| Fact | Source |
|---|---|
| `McpAgent` is deprecated and feature-frozen. New servers use `createMcpHandler` from `agents/mcp/server` with `@modelcontextprotocol/server` v2. | developers.cloudflare.com/agents/model-context-protocol/apis/handler-api |
| `agents` 0.26.0 pins `@modelcontextprotocol/server` 2.0.0. | github.com/cloudflare/agents `packages/agents/package.json` |
| MCP 2026-07-28 removes `initialize` and `Mcp-Session-Id`. Every request carries its own version, identity, and capabilities. Clients send `Mcp-Method` and `Mcp-Name` headers. | modelcontextprotocol.io/specification/2026-07-28 |
| `@cloudflare/workers-oauth-provider` 1.x (latest 1.2.1) has a split API: `OAuthAuthorizationServer` and `OAuthResourceServer`. The KV binding name `OAUTH_KV` is fixed. The split classes have no default handler. | github.com/cloudflare/workers-oauth-provider |
| Token props are encrypted with AES-GCM. Tokens are stored only as hashes. | `docs/authorization-server.md` in the provider repo |
| `OAuthResourceServer` serves the protected resource metadata, answers `401` with `WWW-Authenticate`, and has `insufficientScope()` for step-up. | `src/oauth-resource-server.ts` in the provider repo |
| Under `agents` 0.26.0, tools do not get `authInfo` from `OAuthResourceServer` automatically. The handler must pass it to `handler.fetch(request, { authInfo })`. | `packages/agents/src/mcp/server/handler-stateless.ts` |
| Per-tool `scopeChallenge` needs SDK 2.1.0. | MCP TypeScript SDK server CHANGELOG |
| The SDK v2 does not support the Tasks extension. | MCP TypeScript SDK ROADMAP, issue 2189 |
| The Workers rate limit binding counts per Cloudflare location. It is eventually consistent. The period is 10 or 60 seconds. | developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit |

## 3. Design decisions

| # | Decision | Reason |
|---|---|---|
| D1 | Run the MCP server in a separate Worker, `doxa-mcp`, as a second entrypoint of `apps/api`. | Separate deploys and limits. Agent load does not use dashboard API capacity. The docs resolver already proves the pattern. |
| D2 | Use stateless `createMcpHandler`. No Durable Objects. | The 2026 protocol has no sessions. Each request runs on any instance, so the Worker scales out with load. |
| D3 | Use Workers OAuth Provider v1. `OAuthAuthorizationServer` runs in `doxa-api`. `OAuthResourceServer` runs in `doxa-mcp`. | It implements the MCP authorization spec (CIMD, DCR fallback, resource audiences, step-up). Token checks read KV, not Postgres. |
| D4 | Better Auth stays the login system and does not change. The authorize step reads the Better Auth session. | One identity system. No new Better Auth plugins or tables. |
| D5 | The consent page lives in `apps/web`. | It reuses the design system, the login guard, and the project list. |
| D6 | The user picks projects at consent, or selects all projects. "All projects" includes future projects. | The user confirmed this on 2026-10-04. |
| D7 | Consequential actions go through one gateway in `doxa-api`, exposed to `doxa-mcp` over a service binding. | One execution environment. The MCP Worker holds no secrets and no side-effect bindings. |
| D8 | The approval policy is a registry of action definitions plus an ordered list of policy sources. | The user requires gates that are easy to add, remove, and adjust, and later configurable by users. |
| D9 | Approval happens in the dashboard. MCP elicitation never approves an action. | The agent's own client answers elicitation. In an unattended run, the agent can answer itself. |
| D10 | Publish approval uses the current publish menu. Other actions use one approval page. | The editor already has the review tools. |
| D11 | Agents edit named branches only. | Edits on `main` go to the hidden branch of the user and mix with the human draft. |
| D12 | The server derives the edit origin from the actor. | A client-supplied origin is not a security boundary. |
| D13 | Agents poll an approval request with a tool. | The SDK has no Tasks support. Section 21 lists the follow-up. |
| D14 | Build the access layer for teams now. Ship only the owner policy. | The user confirmed that teams come later. |

## 4. Concepts and vocabulary

Use these words with these meanings in code, UI copy, and docs.

| Word | Meaning |
|---|---|
| agent | An external AI program that calls the MCP server for a user. |
| client | The OAuth client registration of an agent app, for example "Claude Code". |
| grant | The permission that one user gave to one client. A grant has scopes and a project scope. |
| scope | An OAuth scope string, for example `docs:write`. Scopes limit what a grant can do. |
| project scope | The projects in a grant: all projects, or a list of project IDs. |
| capability | An internal permission on one project, for example `docs.publish`. |
| actor | The caller of an operation: a principal (the user) and a channel (dashboard or agent). |
| action | A consequential operation in the action registry, for example `docs.publish`. |
| approval mode | `allow`, `require_approval`, or `deny`. The policy gives one mode for each action. |
| policy source | One input to the approval policy, for example the action default or a future project setting. |
| approval request | A database row that holds a gated action until a human decides. |
| decider | The user who approves or rejects an approval request. |
| review surface | Where a human reviews a request: the publish menu or the approval page. |

## 5. Architecture

```text
Agent (Claude, Cursor, ChatGPT, custom)
   │  Streamable HTTP + Bearer token
   ▼
doxa-mcp Worker            https://mcp.doxa.so/mcp
   ├─ OAuthResourceServer ──AUTH_SERVER (RPC)──────► doxa-api: OAuthTokenValidator ─► OAUTH_KV
   ├─ scope pre-check from Mcp-Method / Mcp-Name headers
   ├─ createMcpHandler (stateless), new McpServer for each request
   ├─ tool runner: scope → rate limit → run → map errors → audit
   ├─ reads and branch writes: apps/api services, in process
   └─ actions ──────────PLATFORM_ACTIONS (RPC)─────► doxa-api: AgentActionsApi ─► gateway
          ▼                                                      ▼
   Postgres (Hyperdrive) · R2                     queues · cache invalidator · Cloudflare API

doxa-api Worker            https://api.doxa.so
   ├─ /.well-known/oauth-authorization-server, /oauth/*   → OAuthAuthorizationServer
   ├─ /oauth/authorize                                    → authorize handler → doxa.so/oauth/consent
   ├─ /agent-access/*                                     → consent and grants API (session)
   └─ /projects/:id/approval-requests/*                   → approval API (session)
```

### 5.1 Request path for a tool call

1. The agent sends `POST /mcp` with `Authorization: Bearer <token>`.
2. `OAuthResourceServer` calls `AUTH_SERVER.validateToken(resource, token)`. An invalid token gets `401` with `WWW-Authenticate`.
3. The MCP Worker reads the `Mcp-Method` and `Mcp-Name` headers. If the tool needs a scope that the token does not have, it returns `insufficientScope()` (section 9.4).
4. The Worker builds an `AgentActor` from the token and a request context with one database pool.
5. `createMcpHandler` runs a new `McpServer` for this request. The tool runner runs the tool.
6. A read or a branch write calls an `apps/api` service in process.
7. A consequential action calls `PLATFORM_ACTIONS.perform(...)`. `doxa-api` checks access again and runs the gateway.
8. The Worker writes an activity row with `waitUntil` and closes the database pool.

### 5.2 Rules for the MCP Worker

- The MCP Worker has no secrets. It has no queue producer, no cache invalidator, no Cloudflare API token, and no GitHub App key.
- An operation that needs one of these goes through `PLATFORM_ACTIONS`.
- The MCP Worker binds Hyperdrive and `DOCS_BUCKET` for reads and branch writes only.
- Place the MCP Worker in `aws:us-east-1`, next to the database, as the API does.

## 6. Authorization server

### 6.1 Configuration

The authorization server lives in `apps/api/src/services/oauth/authorization-server.ts`.

```ts
export function createAuthorizationServer(config: OAuthServerConfig) {
  return new OAuthAuthorizationServer<Env>({
    issuer: config.issuer,                         // https://api.doxa.so
    resources: [config.mcpResource],               // https://mcp.doxa.so/mcp
    authorizeEndpoint: `${config.issuer}/oauth/authorize`,
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [...OAUTH_SCOPES, "offline_access"],
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 24 * 3600,
    refreshTokenIdleTTL: 14 * 24 * 3600,
  });
}
```

- `OAUTH_KV` is a new KV namespace, bound to `doxa-api` only.
- CIMD needs the `global_fetch_strictly_public` flag. `doxa-api` production already has it.
- The issuer and the resource come from vars: `OAUTH_ISSUER` and `MCP_RESOURCE_URL`. Local values are `http://localhost:8787` and `http://localhost:8791/mcp`.

### 6.2 Routing in `doxa-api`

The split classes have no default handler. A dispatcher in `apps/api/src/index.ts` runs before the Hono router.

```ts
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const { pathname } = new URL(request.url);
    if (isOAuthProviderPath(pathname)) {
      return authorizationServerFor(env).fetch(request, env, ctx);
    }
    return app.fetch(request, env, ctx);
  },
  scheduled,
};
```

- `isOAuthProviderPath` is true for `/.well-known/oauth-authorization-server`, and for every path under `/oauth/` except `/oauth/authorize`.
- Provider paths skip the Hono CORS and CSRF middleware. The provider owns their rules.
- `/oauth/authorize` is a Hono `GET` route. A `GET` is safe for CSRF.
- The consent API and the grants API live under `/agent-access/*` in Hono. They use the session cookie and the normal CSRF and CORS rules.
- Export a `WorkerEntrypoint` named `OAuthTokenValidator` with one method: `validateToken(resource: string, token: string)`. It calls `authorizationServer.validateToken(resource, token, env)`.

### 6.3 Scopes

Scopes live in `packages/contracts/src/agent-access.ts`, so the API, the MCP Worker, and the web app share them.

| Scope | Meaning | Implies |
|---|---|---|
| `projects:read` | List and read projects, domains, and generations. | — |
| `projects:write` | Create and delete projects. | `projects:read` |
| `docs:read` | Read pages, structure, site settings, branches, and history. Search docs. | — |
| `docs:write` | Create branches, edit pages and structure, build previews. | `docs:read` |
| `site:write` | Change site settings on a branch. | `docs:read` |
| `domains:write` | Add, check, and remove custom domains. | `projects:read` |
| `publish` | Publish branches and restore publications. | `docs:read` |
| `generation:run` | Start and cancel generations. | `projects:read` |

- `expandScopes(granted)` returns the granted scopes plus every implied scope. This is a pure function.
- If a client requests no scopes, the consent page proposes every scope. The user can clear any scope.

### 6.4 Grant props

```ts
export interface AgentGrantProps {
  version: 1;
  grantRef: string;          // UUID made at consent; the provider does not expose a grant ID to resource servers
  userId: string;
  clientName: string;        // snapshot for display and audit
  projectScope: ProjectScopeClaim;
}

export type ProjectScopeClaim =
  | { kind: "all" }
  | { kind: "selected"; projectIds: string[] };   // 1 to 100 project IDs
```

- Parse props with a Zod schema on every read. An unknown `version` is an invalid token.
- Do not put email, names of projects, or other personal data in props.
- `completeAuthorization` gets `metadata: { clientName, cimd: boolean }` (not encrypted) for the grants list.

### 6.5 Authorize and consent flow

1. The agent opens `GET /oauth/authorize?...` in a browser.
2. The handler calls `parseAuthRequest(request)`.
   - If it throws `AuthorizationError` with `redirectTo`, redirect there.
   - If it throws with no `redirectTo` (unknown client, bad redirect URI), show a plain error page. Never redirect to an unchecked URI.
3. The handler calls `lookupClient(clientId)` and stores a pending consent in `OAUTH_KV`: `{ authRequest, client }` under `agent-consent:<random 32 bytes>`, with a TTL of 10 minutes.
4. The handler redirects to `${WEB_ORIGIN}/oauth/consent?id=<consentId>`.
5. The web route needs a session. If there is none, it redirects to `/login?redirect=/oauth/consent?id=...`. After login, the user comes back.
6. The web page calls `GET /agent-access/consents/:id`. The API returns the client name, the client ID URL (CIMD) or "dynamically registered", the redirect host, the requested scopes, and the projects of the user.
7. The user chooses scopes and the project scope, then clicks Allow or Deny.
8. The web page calls `POST /agent-access/consents/:id/approve` or `/deny`. This route uses the session cookie and the normal CSRF check.
9. On approve, the API deletes the pending consent and calls `completeAuthorization({ request, userId, scope, props, metadata })`. It returns `{ redirectTo }`. On deny, it returns the redirect for `access_denied`.
10. The web page navigates to `redirectTo`. The agent exchanges the code for tokens at `/oauth/token`.

Rules:

- A pending consent is single use. Approve and deny delete it before they act.
- The approve route takes the user ID from the session, never from the body.
- The approved scopes must be a subset of the requested scopes (or of all scopes, if none were requested).
- Selected project IDs must belong to the user at approval time. The API checks them with the access policy.
- The consent page sends `Content-Security-Policy: frame-ancestors 'none'`.
- Show the redirect host and the client identity in large text. Mark a dynamically registered client as "unverified".
- Never auto-approve in v1, also for a client that the user approved before.

### 6.6 Login redirect

- `routes/login.tsx` gets a `validateSearch` with an optional `redirect`.
- Accept only a same-origin relative path that starts with `/` and not with `//`. Ignore every other value and use `/dashboard`.
- Pass the path to `signIn` as the `callbackURL`, and to the `<Navigate>` for a signed-in user.
- Test the open-redirect cases: `//evil.com`, `https://evil.com`, `/\evil.com`, and encoded forms.

### 6.7 Grants and revocation

- `GET /agent-access/grants` calls `listUserGrants(userId)`. It returns the client name, scopes, project scope, creation time, and the last activity time from `agent_activity`.
- `DELETE /agent-access/grants/:grantId` calls `revokeGrant(grantId, userId)`.
- The doxa-api cron runs `purgeExpiredData(env, { batchSize, cursor })`. It saves the cursor in `OAUTH_KV` under `oauth-purge-cursor`.

## 7. Access layer

The access layer lives in `apps/api/src/services/agent-access/`. HTTP routes, the MCP Worker, and the action gateway use it.

### 7.1 Actor

```ts
export type UserId = string & { readonly __brand: "UserId" };
export type ProjectId = string & { readonly __brand: "ProjectId" };

export interface Principal {
  kind: "user";
  userId: UserId;
}

export type Channel = DashboardChannel | AgentChannel;

export interface DashboardChannel {
  kind: "dashboard";
}

export interface AgentChannel {
  kind: "agent";
  clientId: string;
  clientName: string;
  grantRef: string;
  scopes: ReadonlySet<OAuthScope>;     // expanded with implied scopes
  projectScope: ProjectScope;
}

export type ProjectScope =
  | { kind: "all" }
  | { kind: "selected"; projectIds: ReadonlySet<ProjectId> };

export interface Actor {
  principal: Principal;
  channel: Channel;
}

export type DashboardActor = Actor & { channel: DashboardChannel };
export type AgentActor = Actor & { channel: AgentChannel };
```

- Build an actor only in `actor.ts`: `dashboardActor(userId)` and `agentActor(claims)`.
- `editOriginFor(actor)` returns `"editor"` for the dashboard channel and `"mcp"` for the agent channel. No other code chooses an origin.

### 7.2 Capabilities

```ts
export const CAPABILITIES = [
  "project.read",
  "project.create",
  "project.delete",
  "docs.read",
  "docs.write",
  "site.write",
  "docs.publish",
  "docs.restore",
  "domains.read",
  "domains.write",
  "generation.read",
  "generation.run",
  "approvals.decide",
] as const;

export type Capability = (typeof CAPABILITIES)[number];
```

`SCOPE_CAPABILITIES` maps each scope to its capabilities. An agent never gets `approvals.decide`.

### 7.3 Project access policy

```ts
export interface ProjectAccessPolicy {
  authorize(actor: Actor, projectId: string, capability: Capability): Promise<AccessDecision>;
  listAccessibleProjects(actor: Actor): Promise<ProjectDto[]>;
}

export type AccessDecision =
  | { allowed: true; project: AuthorizedProject }
  | { allowed: false; reason: AccessDenialReason };

export type AccessDenialReason =
  | "not_found"              // no project, or the principal has no role on it
  | "scope_missing"          // the grant does not have the scope
  | "project_not_in_grant"   // the project is outside the project scope
  | "forbidden";             // the principal has a role without this capability (teams)

export interface AuthorizedProject {
  readonly projectId: ProjectId;
  readonly ownerUserId: UserId;
  readonly capabilities: ReadonlySet<Capability>;
}
```

The effective capabilities of an actor are:

1. the capabilities of the principal on the project (from the role), then
2. for the agent channel, the intersection with `SCOPE_CAPABILITIES` of the granted scopes, then
3. for the agent channel, nothing if the project is outside the project scope.

`OwnerProjectAccessPolicy` is the only v1 implementation. The owner has every capability. Any other user gets `not_found`. This matches the current `404` behavior and does not reveal that a project exists.

### 7.4 Use in services

- Only the policy creates an `AuthorizedProject`.
- New code receives an `AuthorizedProject`, not a raw `projectId` and `userId`.
- Current services keep their `userId` parameter. Until the teams spec, new code passes `authorized.ownerUserId`. The SQL ownership joins stay as a second layer.

### 7.5 HTTP routes

- v1 uses the access layer in the MCP Worker, in the action gateway, and in the new routes of this spec.
- The current dashboard routes keep `withUser`. The teams spec moves them to the access layer.
- `routes/docs-content.ts` stops reading `origin` from the body. It uses `editOriginFor(dashboardActor(userId))`. Remove `origin` from `applyDocsContentEditsInputSchema`. Update the web app if it sends the field.

### 7.6 Teams seams

These seams make teams an additive change:

- The actor separates the principal from the channel.
- Permissions are capabilities, not an "is owner" check.
- `ProjectAccessPolicy` is an interface. Teams add `MembershipProjectAccessPolicy`, which maps a role to capabilities.
- An approval request stores the requester and the decider separately. Deciding needs `approvals.decide`, not ownership.
- The approval policy has ordered sources. A team or project source is one new class (section 8.9).
- A grant project scope holds project IDs, not owner IDs. Team projects can join the list with no token change.
- New tables have no "owner" column. They key on `project_id` and on the acting user.

## 8. Agent actions and approvals

The action layer lives in `apps/api/src/services/agent-actions/`.

### 8.1 Action definition

Each action is one module that exports one definition.

```ts
export type ApprovalMode = "allow" | "require_approval" | "deny";

export type ReviewSurface =
  | { kind: "publish_menu" }
  | { kind: "approval_page" };

export interface ActionApprovalRules {
  defaultMode: ApprovalMode;
  allowedModes: readonly ApprovalMode[];   // the floor and the ceiling for every policy source
  ttlHours: number;                        // a pending request expires after this time
}

export interface AgentActionDefinition<TPayload, TSnapshot, TResult> {
  readonly kind: AgentActionKind;
  readonly payloadVersion: number;
  readonly title: string;                  // "Publish a branch"
  readonly capability: Capability;
  readonly payloadSchema: z.ZodType<TPayload>;
  readonly snapshotSchema: z.ZodType<TSnapshot>;
  readonly resultSchema: z.ZodType<TResult>;
  readonly approval: ActionApprovalRules;
  readonly review: ReviewSurface;
  targetKey(payload: TPayload): string;
  describe(payload: TPayload, snapshot: TSnapshot): ActionDescription;
  capture(context: ActionContext, payload: TPayload): Promise<TSnapshot>;
  checkFresh(context: ActionContext, payload: TPayload, snapshot: TSnapshot): Promise<Freshness>;
  execute(context: ActionExecution, payload: TPayload, snapshot: TSnapshot): Promise<TResult>;
}

export type Freshness =
  | { fresh: true }
  | { fresh: false; reason: StaleReason; message: string };

export interface ActionDescription {
  headline: string;                  // "Publish 3 changes from agent-rate-limits"
  effects: readonly string[];        // "The live site at acme.doxa.page changes."
}
```

- `capture` records the preconditions when the request starts. For a publish, these are the branch ID, the base version, and the revision.
- `checkFresh` runs before execution. A request whose preconditions changed becomes `stale`.
- `execute` is the only place that calls the side-effect service. The same function runs for an allowed action and for an approved request.
- `targetKey` names the target, for example the branch ID or the hostname. It prevents two pending requests for one target.

### 8.2 Registry

```ts
export const AGENT_ACTIONS = defineActionRegistry([
  docsPublishAction,
  docsRestoreAction,
  domainAddAction,
  domainRemoveAction,
  projectCreateAction,
  projectDeleteAction,
  generationStartAction,
]);

export type AgentActionKind = keyof typeof AGENT_ACTIONS;
```

`defineActionRegistry` builds a map keyed by `kind` and rejects duplicate kinds at module load.

### 8.3 v1 actions

| Kind | Scope | Capability | Default mode | Allowed modes | Review surface | Execute calls |
|---|---|---|---|---|---|---|
| `docs.publish` | `publish` | `docs.publish` | `require_approval` | all | publish menu | `DocsBranchPublish.publish` |
| `docs.restore` | `publish` | `docs.restore` | `require_approval` | all | approval page | `DocsBranchHistory.restore` |
| `domain.add` | `domains:write` | `domains.write` | `require_approval` | all | approval page | `DocsDomainLifecycleService.createCustomDomain` |
| `domain.remove` | `domains:write` | `domains.write` | `require_approval` | all | approval page | `DocsDomainLifecycleService.deleteForProject` |
| `project.create` | `projects:write` | `project.create` | `allow` | all | approval page | `createExampleProject` or `ProjectsRepository.createForRepository` |
| `project.delete` | `projects:write` | `project.delete` | `require_approval` | `require_approval`, `deny` | approval page | `deleteProject` |
| `generation.start` | `generation:run` | `generation.run` | `require_approval` | all | approval page | `GenerationStartService.start` |

- `project.delete` can never be `allow`. To change this, edit `allowedModes` in its module.
- The approval page for `generation.start` says: "The generated docs go live when the run completes."
- `project.create` has no project yet. Its access check uses the principal only. Its approval requests (if a source requires one) attach to the user, with `project_id` null.

### 8.4 Approval policy

```ts
export interface ApprovalPolicyQuery {
  actor: AgentActor;
  projectId: ProjectId | null;
  action: AgentActionKind;
}

export interface ApprovalPolicySource {
  readonly name: string;
  modeFor(query: ApprovalPolicyQuery): Promise<ApprovalMode | undefined>;
}

export class ApprovalPolicyResolver {
  constructor(private readonly sources: readonly ApprovalPolicySource[]) {}

  async resolve(query: ApprovalPolicyQuery): Promise<ResolvedApprovalMode> {
    const rules = AGENT_ACTIONS[query.action].approval;
    for (const source of this.sources) {
      const mode = await source.modeFor(query);
      if (mode !== undefined && rules.allowedModes.includes(mode)) {
        return { mode, source: source.name };
      }
    }
    return { mode: rules.defaultMode, source: "action_default" };
  }
}
```

- The first source that returns an allowed mode wins. A mode outside `allowedModes` is ignored and logged.
- v1 has one source: `PlatformOverrideSource`. It reads a typed constant in `policy/platform-overrides.ts`. The constant is empty at launch.
- The action default applies when no source answers.
- `ResolvedApprovalMode.source` goes into the activity log, so an operator can see why a gate applied.

### 8.5 Gateway

```ts
export class AgentActionGateway {
  constructor(private readonly deps: AgentActionGatewayDeps) {}

  async perform<K extends AgentActionKind>(
    actor: AgentActor,
    request: PerformActionRequest<K>,
  ): Promise<PerformActionResult<K>>;
}

export type PerformActionResult<K extends AgentActionKind> =
  | { outcome: "completed"; result: ActionResult<K> }
  | { outcome: "approval_required"; request: ApprovalRequestSummary };
```

`perform` runs these steps:

1. Parse the payload with the action's `payloadSchema`.
2. Check the scope and the capability with the access policy. A failure throws `AccessDeniedError`.
3. Resolve the approval mode.
4. If the mode is `deny`, throw `ActionDeniedError`.
5. If the mode is `allow`, call `capture`, `checkFresh`, and `execute`. Return `completed`.
6. If the mode is `require_approval`, call `capture`, then insert an approval request. Return `approval_required` with the summary.

If a pending request for the same `(project_id, action_kind, target_key)` exists:

- If its snapshot equals the new snapshot, return the existing request. The call is idempotent.
- Otherwise, mark the old request `stale` and insert the new one, in one transaction.

### 8.6 Approval request lifecycle

```text
pending ──approve──► executing ──► completed
   │                     └───────► failed
   ├──reject───► rejected
   ├──cancel───► cancelled          (the agent or the user)
   ├──expire───► expired            (cron, after ttlHours)
   └──stale────► stale              (checkFresh failed, or a newer request replaced it)
```

- `approve` locks the row with `SELECT ... FOR UPDATE` and moves `pending` to `executing` before it runs `checkFresh`. A second approve finds `executing` and fails with `request_not_pending`.
- If `checkFresh` fails, the status becomes `stale` with the reason. Nothing executes.
- `execute` runs outside the row lock. The final update moves `executing` to `completed` or `failed`.
- If a Worker stops during execution, the row stays `executing`. The cron marks a row `failed` after 15 minutes in `executing`, with `execution_interrupted`. A publish is safe to retry because of its compare-and-set checks.
- Terminal states are `completed`, `failed`, `rejected`, `cancelled`, `expired`, and `stale`. A terminal row never changes again.

### 8.7 Approval service

`ApprovalService` serves the dashboard and the agent:

- `list(actor, projectId, filter)` and `get(actor, requestId)`.
- `approve(actor, requestId, options)` needs `approvals.decide`. It accepts only a dashboard actor. `options.onProgress` passes publish stages to an SSE response.
- `reject(actor, requestId, reason)` needs `approvals.decide`. The reason has at most 500 characters. The agent sees it.
- `cancel(actor, requestId)` works for the requesting client (same user and same client ID) or for a decider.
- `expireDue(now)`, `markStale()`, and `failInterrupted(now)` run in the cron. `markStale()` runs `checkFresh` for pending requests and marks the stale ones.

### 8.8 Freshness rules for v1

| Action | Snapshot | Stale when |
|---|---|---|
| `docs.publish` | `branchId`, `baseVersionId`, `revision` | The branch is gone, the revision changed, or `main` moved (`branch_behind`). |
| `docs.restore` | `expectedMainVersionId` | `main` moved. |
| `domain.add` | none | Never. Execution can still fail (hostname taken, limit reached). |
| `domain.remove` | `domainId`, `hostname` | The domain is gone. |
| `project.delete` | `projectName` | The project is gone. |
| `generation.start` | `force` | A generation is active. |

### 8.9 Extensibility recipes

These recipes are the contract for future changes to gates.

**Make a gated action ungated (for example, publish without approval):**

1. In `actions/docs-publish.ts`, set `approval.defaultMode` to `"allow"`.
2. Run the policy tests.

**Gate an action for one project or one user without a code release:** add an entry to `policy/platform-overrides.ts`. The entry has the action kind, the target (a project ID or a user ID), and the mode.

**Add a new gated action:**

1. Add a module in `agent-actions/actions/` that exports an `AgentActionDefinition`.
2. Add it to `AGENT_ACTIONS`.
3. Add the MCP tool with `action: "<kind>"` (section 9.3).
4. If the review surface is new, add one renderer to the approval page.

No migration is necessary, because `action_kind` is `text`.

**Remove an action:**

1. Remove the tool and the registry entry.
2. The cron marks pending rows of an unknown kind `expired`, with `action_removed`.
3. The dashboard shows "This action is no longer available" for old rows.

**Let users choose the gates (planned):**

1. Add the table `agent_action_policies`: `id`, `subject_kind` (`project` or `user`), `subject_id`, `action_kind`, `mode`, `updated_by_user_id`, `updated_at`, with a unique index on `(subject_kind, subject_id, action_kind)`.
2. Add `ProjectSettingSource` and `UserSettingSource`, which read this table.
3. Insert them in the resolver after `PlatformOverrideSource`. The order is a product decision for that work, and it is a list order.
4. Add the settings UI. It offers only the `allowedModes` of each action.

Gateways, tools, and approval requests do not change for any of these recipes.

### 8.10 Execution identity

- An allowed action runs as the agent actor.
- An approved request runs with the decider as the actor that decided, and with the requester as the principal that requested. `execute` receives both in `ActionExecution`.
- Services that need a `userId` get `authorized.ownerUserId` (section 7.4).

## 9. MCP server

The MCP code lives in `apps/api/src/mcp/` and the Worker entry is `apps/api/src/mcp.ts`.

### 9.1 Worker entry

```ts
const resourceServer = new OAuthResourceServer<McpEnv, AgentGrantProps>({
  resourceMetadata: {
    resource: MCP_RESOURCE_URL,
    authorization_servers: [OAUTH_ISSUER],
    resource_name: "Doxa",
  },
  validateToken: (env) => env.AUTH_SERVER.validateToken,
  handler: { fetch: handleAuthenticatedMcpRequest },
});

export default resourceServer;
```

- Read `MCP_RESOURCE_URL` and `OAUTH_ISSUER` from the env. Phase 0 checks whether the options accept a function of the env. If not, build the resource server in the first request and keep it in module scope.
- `handleAuthenticatedMcpRequest(request, env, ctx)` runs these steps:
  1. Parse `ctx.props` with the `AgentGrantProps` schema.
  2. Build the `AgentActor` from `ctx.auth` and the props.
  3. Run the scope pre-check (section 9.4).
  4. Open a request database scope (section 10.5).
  5. Build the `McpRequestContext`.
  6. Call `createMcpHandler(() => createDoxaMcpServer(context), MCP_HANDLER_OPTIONS).fetch(request, { authInfo })`.
  7. Close the database scope with `ctx.waitUntil`.
- Build the handler for each request. The closure gives explicit dependencies. The server uses no subscriptions, so a module-scope handler has no benefit.
- `MCP_HANDLER_OPTIONS` sets `route: "/mcp"`, `allowedHostnames` and `allowedOriginHostnames` to the MCP host, and `legacy: "stateless"`.
- Build `authInfo` from `ctx.auth`: `token`, `clientId`, `scopes`, `expiresAt`, `resource`. Never return `authInfo` to a client.
- The request body limit is 4 MiB. A bigger body gets `413` before MCP parsing.

### 9.2 Server factory

```ts
export function createDoxaMcpServer(context: McpRequestContext): McpServer {
  const server = new McpServer(DOXA_SERVER_INFO, { capabilities: DOXA_CAPABILITIES });
  registerTools(server, TOOLS, context);
  registerResources(server, RESOURCES, context);
  return server;
}
```

- `DOXA_SERVER_INFO` has the name `doxa` and the package version.
- The server instructions text tells the agent the workflow: find the project, create a named branch, edit, build a preview, then call `publish_branch`. It also says that a gated action returns an approval link and that the agent must give the link to the user.

### 9.3 Tool definition

```ts
export type ToolCost = "read" | "write" | "expensive";

export interface McpToolDefinition<TInput extends z.ZodObject, TOutput extends z.ZodType> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly scope: OAuthScope | null;       // null: any valid token
  readonly cost: ToolCost;
  readonly annotations: ToolAnnotations;
  readonly input: TInput;
  readonly output: TOutput;
  readonly action?: AgentActionKind;       // set only for tools that call the gateway
  run(context: ToolContext, input: z.infer<TInput>): Promise<z.infer<TOutput>>;
}

export function defineMcpTool<TInput extends z.ZodObject, TOutput extends z.ZodType>(
  definition: McpToolDefinition<TInput, TOutput>,
): McpToolDefinition<TInput, TOutput> {
  return definition;
}
```

- Each tool is one file under `mcp/tools/<domain>/`. `mcp/tools/index.ts` exports `TOOLS`.
- A tool with `action` builds the payload and calls `context.actions.perform(...)`. It has no other side effects.
- Every input schema is `.strict()`. IDs are UUIDs. Strings have maximum lengths.

### 9.4 Scope pre-check and step-up

- `TOOL_SCOPES` is a map from tool name to scope, built from `TOOLS`.
- If `Mcp-Method` is `tools/call` and the scope for `Mcp-Name` is not in the token, return `insufficientScope(ctx.auth, [...grantedScopes, requiredScope])`. The challenge holds the full scope set that the client needs, as the spec asks.
- 2025 clients do not send these headers. For them, the tool runner checks the scope and returns a tool error with the code `insufficient_scope`.
- When the SDK under `agents` reaches 2.1, replace the header check with per-tool `scopeChallenge` (section 21).

### 9.5 Tool runner

`registerTools` wraps each tool in `runTool`:

1. Check the scope (second layer).
2. Check the rate limit for the tool cost (section 13.1).
3. Parse the input. The SDK returns a validation error as a tool error.
4. Run the tool.
5. Parse the output with the output schema. A failure is an internal error. Log it.
6. For `write` and `expensive` tools, write an activity row with `waitUntil`.
7. Return `{ content: [{ type: "text", text }], structuredContent }`. The text is the JSON of the structured content.

### 9.6 Tool errors

A tool error is `{ isError: true, structuredContent: { error } }`:

```ts
export interface ToolErrorBody {
  code: ToolErrorCode;
  message: string;                 // one or two sentences for the agent
  hint?: string;                   // the next step, for example "Call sync_branch first."
  issues?: ValidationIssue[];      // from site config and branch validation
  details?: Record<string, string | number | boolean>;
  requestId: string;               // matches the log line
}
```

`mapToolError(error)` in `mcp/errors.ts` is the only place that converts an exception. It covers:

| Source | Codes |
|---|---|
| Access layer | `not_found`, `scope_missing`, `project_not_in_grant`, `forbidden`, `insufficient_scope` |
| Rate limit | `rate_limited` with `retryAfterSeconds` |
| Gateway | `action_denied`, `request_not_pending`, `request_not_found` |
| `DocsContentError` | `branch_not_found`, `conflict` (with `currentRevision`), `branch_behind`, `main_changed`, `conflicts_unresolved`, `no_changes`, `preview_rate_limited`, `invalid` |
| `SiteConfigValidationError`, `DocsBranchValidationError`, `SyncValidationError` | `validation_failed` with `issues` |
| MDX check | `mdx_invalid` with `issues` |
| `CreateProjectError`, `ProjectDeletionError` | the error code |
| `CreateCustomDocsDomainError`, `DocsDomainProvisioningError` | the error code, or `domain_provider_error` |
| `ActiveGenerationConflictError` | `generation_active` |
| Anything else | `internal_error`. Log the stack with the request ID. Never return it. |

### 9.7 Tool catalog

`R` is read only, `D` is destructive, `I` is idempotent. All tools set `openWorldHint: false`, except `check_domain`.

**Account and projects**

| Tool | Scope | Cost | Hints | Backed by |
|---|---|---|---|---|
| `get_account` | none | read | R | actor, grant |
| `list_projects` | `projects:read` | read | R | `ProjectAccessPolicy.listAccessibleProjects` |
| `get_project` | `projects:read` | read | R | `ProjectsRepository.getForUser`, latest generation, docs URL |
| `list_github_repositories` | `projects:read` | read | R | the installed GitHub repositories of the user |
| `create_project` | `projects:write` | expensive | — | action `project.create` |
| `delete_project` | `projects:write` | expensive | D | action `project.delete` |

`create_project` takes `source: { kind: "example" } | { kind: "github"; repositoryId }`, a `name`, and an optional `slug`. A GitHub project does not start a generation. The agent calls `start_generation` for that.

**Docs (read)**

| Tool | Scope | Cost | Hints | Backed by |
|---|---|---|---|---|
| `get_docs_structure` | `docs:read` | read | R | `DocsContentService.getOverview` |
| `read_page` | `docs:read` | read | R | `DocsContentService.getPage` |
| `search_docs` | `docs:read` | read | R | the published search index and `createSearchEngine` |

- Read tools take an optional `branch` (`"main"` or a branch ID). Results include the branch revision.
- `search_docs` searches the live site only. The description says so.

**Branches**

| Tool | Scope | Cost | Hints | Backed by |
|---|---|---|---|---|
| `list_branches` | `docs:read` | read | R | `DocsBranchService.list` |
| `create_branch` | `docs:write` | write | — | `DocsBranchService.create` |
| `get_branch_status` | `docs:read` | read | R | `DocsBranchStatusRepository.get` |
| `sync_branch` | `docs:write` | write | — | `previewSync` when `dryRun` (default `true`), else `synchronize` |
| `build_preview` | `docs:write` | expensive | I | `DocsBranchPreview.build` |

- `create_branch` suggests the prefix `agent-` in its description. Branch names follow `BRANCH_NAME_PATTERN`.
- On `branch_limit_reached`, the hint lists the branches that exist.

**Docs (write)**

| Tool | Scope | Cost | Hints | Backed by |
|---|---|---|---|---|
| `write_page` | `docs:write` | write | I | one `set_page_content` edit |
| `edit_docs` | `docs:write` | write | — | `DocsContentService.applyEdits` |

- Both tools need a named branch ID. `"main"` is rejected with a hint to call `create_branch`.
- Both take an optional `expectedRevision`. If it differs, the result is `conflict` with `currentRevision` (section 10.2).
- Both run the MDX check on each page source before the write (section 10.6).
- `edit_docs` accepts the `docsContentEditSchema` union without `set_site_config` and `reset_site_config`. It accepts 1 to 50 edits.
- `edit_docs` takes `dryRun`. A dry run validates and returns the issues. It writes nothing.

**Site settings**

| Tool | Scope | Cost | Hints | Backed by |
|---|---|---|---|---|
| `get_site_settings` | `docs:read` | read | R | the overview `siteConfig` (published and working) |
| `update_site_settings` | `site:write` | write | I | one `set_site_config` edit |

`update_site_settings` takes a named branch ID and one of `{ mode: "replace"; config }` or `{ mode: "merge_patch"; patch }`. A merge patch follows RFC 7396. The server applies the patch to the working config, then validates the result with `validateSiteConfig` and `validateConfigForSite`.

**Publish and history**

| Tool | Scope | Cost | Hints | Backed by |
|---|---|---|---|---|
| `publish_branch` | `publish` | expensive | D | action `docs.publish` |
| `list_publications` | `docs:read` | read | R | `DocsBranchHistory.list` |
| `restore_publication` | `publish` | expensive | D | action `docs.restore` |

`publish_branch` takes the branch ID and a `summary` of at most 500 characters. The summary shows in the publish menu.

**Approval requests**

| Tool | Scope | Cost | Hints | Backed by |
|---|---|---|---|---|
| `get_approval_request` | none | read | R | `ApprovalService.get` |
| `list_approval_requests` | none | read | R | `ApprovalService.list`, rows of this client |
| `cancel_approval_request` | none | write | I | `ApprovalService.cancel` |

A pending result has `pollAfterMs: 10000`. The tool description tells the agent to wait that long between checks.

**Domains**

| Tool | Scope | Cost | Hints | Backed by |
|---|---|---|---|---|
| `list_domains` | `projects:read` | read | R | `DocsDomainLifecycleService.listForProject` |
| `add_domain` | `domains:write` | expensive | — | action `domain.add` |
| `check_domain` | `domains:write` | expensive | I | `DocsDomainLifecycleService.refreshForProject` |
| `remove_domain` | `domains:write` | expensive | D | action `domain.remove` |

`add_domain` returns the DNS records that the user must create, when the action completes.

**Generation**

| Tool | Scope | Cost | Hints | Backed by |
|---|---|---|---|---|
| `start_generation` | `generation:run` | expensive | — | action `generation.start` |
| `get_generation` | `projects:read` | read | R | `JobsRepository.getDetailForProject` and recent events |
| `cancel_generation` | `generation:run` | write | I | `cancelGenerationJob` |

### 9.8 Results of action tools

Every action tool returns this union, whatever the policy says:

```ts
export type ActionToolOutput<TResult> =
  | { outcome: "completed"; result: TResult }
  | {
      outcome: "approval_required";
      request: {
        id: string;
        status: "pending";
        approvalUrl: string;        // https://doxa.so/approve/<id>
        expiresAt: string;
        pollAfterMs: number;
      };
      message: string;              // "Ask the user to approve this publish at <url>."
    };
```

- An agent handles both outcomes. When a gate changes, the tool contract does not change.
- For clients that support URL elicitation, Phase 6 adds `inputRequired.elicitUrl({ message, url })` as an extra hint. The approval itself still happens in the dashboard.

### 9.9 Resources

| URI | Scope | Content |
|---|---|---|
| `doxa://projects/{projectId}/pages/{+href}` | `docs:read` | The live MDX source of one page. |
| `doxa://schemas/site-config` | none | `siteConfigJsonSchema()`. |
| `doxa://reference/mdx` | none | The supported MDX components and their props. |

- Build `doxa://reference/mdx` from `RUNTIME_MDX_COMPONENT_NAMES`, plus the component guidance that the generation writer already uses in `packages/agent`. Phase 4 finds that guidance and reuses it. Do not write a second copy.
- Cache hints: `private`, `ttlMs: 0` for project data. `public`, `ttlMs: 3600000` for the schema and the reference.

## 10. Changes to current code

### 10.1 Edit origin

- `routes/docs-content.ts:64` uses `editOriginFor(dashboardActor(userId))`.
- Remove `origin` from `applyDocsContentEditsInputSchema`.
- `DocsContentActor` becomes `{ userId: string; origin: DocsContentEditOrigin }` built only by `editOriginFor`. The MCP Worker passes `"mcp"`.
- `erase` and `discard` keep their origin check. Agents get no tool for them in v1.

### 10.2 Expected revision for edits

- `applyEdits(actor, projectId, edits, branchRef, options?: { expectedRevision?: number })`.
- If `expectedRevision` is set and differs from the current revision, throw `DocsContentError("conflict", ..., { currentRevision })` with no retry.
- If it is not set, keep the current retry loop. The dashboard does not change.

### 10.3 Generation start service

- Move the route logic from `routes/projects.ts:162-263` to `services/generation-start.ts`.
- `GenerationStartService.start({ userId, projectId, force }): Promise<GenerationStartOutcome>`.
- The outcome is a discriminated union: `started`, `already_active`, `confirmation_required`, `repository_required`, `paused`.
- A `GenerationDispatcher` interface hides the generation modes. The `container-inline` dispatcher receives a `defer(promise)` function instead of the Hono context.
- The route becomes a thin shell. Its responses do not change. Its tests must pass with no change.

### 10.4 Publication attribution

- Add nullable columns to `docs_publications`: `agent_client_id text`, `agent_client_name text`, `approval_request_id uuid` (FK to `agent_approval_requests`, `on delete set null`).
- `DocsBranchPublish.publish` and `DocsBranchHistory.restore` take an optional `attribution: { agentClientId; agentClientName; approvalRequestId? }`.
- `docsPublicationSchema` gains `agent: { clientName: string; approvalRequestId: string | null } | null`.
- The history panel shows "Published by Claude Code, approved by you" when `agent` is set.
- `kind` and the `.strict()` summary schema do not change.

### 10.5 One database pool for each request

- Add `createRequestDbScope(env)` to `packages/db`. It returns `{ env, close }`.
- The scoped `env` is a shallow copy of `env`, registered in a module `WeakMap`. `createDb` and `createCachedDb` return the scope's single pool for a scoped env.
- `close()` ends the pool. The MCP Worker calls it with `waitUntil`.
- Repositories do not change. The dashboard routes can adopt the scope later.

### 10.6 MDX check for agent writes

- `checkMdxSource(source): ValidationIssue[]` in `apps/api/src/services/docs-content/mdx-check.ts` calls `parseRuntimeMdx`. It maps a parse error to an issue with the code `mdx_invalid` and the line, if known.
- Add `mdx_invalid` to `VALIDATION_ISSUE_CODES` and its message to the message table.
- `write_page` and `edit_docs` run it for each page source. The dashboard save path does not change in v1.

### 10.7 Branching contract

Replace the last paragraph of the "Authorization" section in `docs/current/docs-branching.md` with:

> Only dashboard actions can erase branches. Agents publish branches and restore publications only through the agent action gateway, under the approval policy. See `docs/current/agent-actions.md`.

### 10.8 CSRF, CORS, and the tunnel

- No change to the CSRF lists. Provider paths run before Hono (section 6.2).
- Add `/oauth`, `/.well-known`, and `/agent-access` to the dev tunnel path lists.
- Add a route for the MCP host to the tunnel config.

## 11. Data model

Migration `0026`: `agent_activity`. Migration `0027`: `agent_approval_requests`, the publication columns, and the foreign key from `agent_activity.approval_request_id`. The column exists from `0026`. The constraint comes in `0027`, after its target table exists.

### 11.1 `agent_approval_requests`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK, `defaultRandom()` | |
| `project_id` | `uuid` null, FK `projects.id`, cascade | Null only for `project.create`. |
| `action_kind` | `text` not null | Checked in app code against `AGENT_ACTIONS`. |
| `target_key` | `text` not null | From `targetKey(payload)`. |
| `status` | `pgEnum agent_approval_request_status` not null | `pending`, `executing`, `completed`, `failed`, `rejected`, `cancelled`, `expired`, `stale` |
| `payload_version` | `integer` not null | |
| `payload` | `jsonb` not null | Parsed with the action schema on read. |
| `snapshot` | `jsonb` not null | |
| `summary` | `text` null | Agent text, at most 500 characters. |
| `result` | `jsonb` null | |
| `error` | `jsonb` null | `{ code, message }` |
| `requested_by_user_id` | `text` not null, FK `user.id`, cascade | The principal. |
| `requested_by_client_id` | `text` not null | |
| `requested_by_client_name` | `text` not null | Snapshot for display. |
| `grant_ref` | `text` not null | |
| `decided_by_user_id` | `text` null, FK `user.id`, set null | |
| `decision_note` | `text` null | The reject reason. |
| `policy_source` | `text` not null | From `ResolvedApprovalMode.source`. |
| `created_at`, `updated_at` | `timestamptz` not null, `defaultNow()` | |
| `decided_at`, `completed_at` | `timestamptz` null | |
| `expires_at` | `timestamptz` not null | |

Indexes and checks:

- `agent_approval_requests_project_status_created_idx` on `(project_id, status, created_at)`.
- `agent_approval_requests_requester_created_idx` on `(requested_by_user_id, created_at)`.
- Partial unique index `agent_approval_requests_pending_target_idx` on `(project_id, action_kind, target_key) where status = 'pending'`.
- Check: `summary` length is at most 500. `decision_note` length is at most 500.

### 11.2 `agent_activity`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `occurred_at` | `timestamptz` not null, `defaultNow()` | |
| `user_id` | `text` not null, FK `user.id`, cascade | |
| `client_id`, `client_name`, `grant_ref` | `text` not null | |
| `project_id` | `uuid` null, FK `projects.id`, cascade | |
| `tool` | `text` not null | |
| `action_kind` | `text` null | |
| `approval_request_id` | `uuid` null, FK, set null | |
| `outcome` | `pgEnum agent_activity_outcome` not null | `succeeded`, `failed`, `approval_required`, `denied`, `rate_limited` |
| `error_code` | `text` null | |
| `policy_source` | `text` null | |
| `duration_ms` | `integer` not null | |
| `input_sha256` | `text` null | A hash of the input. Never the content. |

- Indexes: `(project_id, occurred_at)` and `(user_id, occurred_at)`.
- Only `write` and `expensive` tools and approval decisions write rows. Reads go to the Worker logs.
- The cron deletes rows older than 90 days.
- The table is append only. No code updates a row.

### 11.3 `docs_publications`

Section 10.4 lists the new columns.

## 12. Dashboard

### 12.1 Consent page

- Route: `apps/web/src/routes/oauth/consent.tsx` → `components/oauth/consent-page.tsx`.
- Layout: the centered bordered card of the login page.
- Content: the client name and identity, the redirect host, the scopes as plain sentences with checkboxes, and the project picker ("All projects, including future projects" or a list with checkboxes).
- Buttons: "Allow" (primary) and "Deny" (outline).

### 12.2 Connected agents

- A `ConnectedAgentsSection` in `settings-page.tsx`, next to the GitHub section.
- One row for each grant: client name, scopes, project scope, connected date, last activity, and a "Revoke" button.

### 12.3 Approval link resolver

- Route: `apps/web/src/routes/approve/$requestId.tsx`.
- It calls `GET /approval-requests/:id`. The API checks access and returns the project ID, the action kind, and the review surface.
- `publish_menu` redirects to `/dashboard/projects/$projectId/content?branch=<branchId>&request=<requestId>`.
- `approval_page` redirects to `/dashboard/projects/$projectId/requests/$requestId`.

### 12.4 Publish menu approval state

- `content.tsx` gets a `validateSearch` with optional `branch` and `request` (UUIDs). The route seeds the branch selection and opens the publish menu.
- `PublishMenu` gets a third view, `"approval"`. It shows:
  - the client name and the request time,
  - the agent summary,
  - the changed pages, each with a "Diff" button,
  - the "Preview URL" button,
  - "Reject" (outline) and "Approve and publish" (primary).
- "Approve and publish" calls `POST /projects/:id/approval-requests/:rid/approve` with `Accept: text/event-stream`. The progress panel reuses `PUBLISH_STEPS`.
- The menu compares the request revision with the current branch revision. If they differ, the menu shows "The branch changed after the request. The agent must ask again." and the normal "Publish" button comes back. The server marks the request `stale` on the next approve attempt or in the cron.
- The per-page diff reuses `conflict-diff-view.tsx`. It compares the base version with the branch.

### 12.5 Approval requests pages

- Sidebar: a "Requests" item in `project-sidebar-view.tsx`, with a count of pending requests.
- `/dashboard/projects/$projectId/requests`: a table of requests (action, agent, status, time).
- `/dashboard/projects/$projectId/requests/$requestId`: the approval page. It shows the agent, the action title, the inputs, the `effects` lines from `describe`, and "Approve" and "Reject".
- For `project.delete` and `domain.remove`, the user must type the project name to enable "Approve".
- A branch with a pending publish request shows a banner in the editor (`branch-status-banner.tsx`).

### 12.6 Data layer

- API calls in `apps/web/src/lib/agent-access-api.ts` and `lib/approval-requests-api.ts`.
- Query factories in `lib/queries/agent-access.ts` and `lib/queries/approval-requests.ts`.
- Follow the dashboard architecture rules in `AGENTS.md`.

## 13. Scale and limits

### 13.1 Rate limits

Three rate limit bindings in `doxa-mcp`, all with a 60-second period:

| Binding | Key | Limit | Used by |
|---|---|---|---|
| `MCP_READ_LIMITER` | `userId:clientId` | 600 | `read` tools |
| `MCP_WRITE_LIMITER` | `userId:clientId` | 120 | `write` tools |
| `MCP_EXPENSIVE_LIMITER` | `userId` | 20 | `expensive` tools |

- These limits stop abuse. They are not quotas. The binding counts per location and is eventually consistent.
- The values live in `mcp/rate-limit.ts`. Change them there.
- A refusal returns `rate_limited` with `retryAfterSeconds: 60`.

### 13.2 Other limits

- The domain tools share the account-wide Cloudflare API limit (1,200 requests for each 5 minutes for each token). The `expensive` limit protects it.
- A preview build is limited to one for each 10 seconds for each branch (current behavior).
- Branch writes lock only their branch row. Writes to different branches run in parallel.
- Token checks read `OAUTH_KV`. They never read Postgres.
- One MCP request opens at most one database pool (section 10.5).

### 13.3 Load test

Before launch, run a load test against a staging deployment:

- 2,000 concurrent test agents, each with its own grant.
- Traffic: 80% reads, 15% branch writes, 5% action tools.
- Targets: p95 latency below 400 ms for reads of pages up to 50 KB, error rate below 0.1%, no Hyperdrive connection errors.
- Record the results in `docs/current/mcp-server.md`.

A staging deployment, test tokens, and the test cost need approval.

## 14. Security

| Threat | Control |
|---|---|
| Stolen access token | 1-hour access tokens, refresh rotation, revocation in "Connected agents". KV stores token hashes only. |
| Consent phishing | The consent page shows the client identity and the redirect host. It marks unverified clients. No auto-approval. `frame-ancestors 'none'`. |
| Agent approves its own action | No approve tool. The approve route accepts only a dashboard session with the CSRF check. Destructive actions need a typed confirmation. |
| Access to another user's project | Access policy, then the SQL owner joins. Tests for each tool. |
| Project outside the grant | The access policy checks the project scope for every call. |
| Client-supplied origin | The server derives the origin (section 10.1). |
| Approval of a changed branch | The snapshot and `checkFresh`. Publish keeps its compare-and-set checks. |
| Double execution | The row lock and the `pending` to `executing` transition. |
| Open redirect after login | Same-origin relative paths only (section 6.6). |
| SSRF through CIMD | `global_fetch_strictly_public`. |
| Prompt injection in docs content | Gates on consequential actions. Content is returned as data, never as instructions. |
| Denial of service | Rate limits, the 4 MiB body limit, and the current size limits for pages and configs. |
| Leaked internal errors | `mapToolError` returns `internal_error` with a request ID only. |

A security review of the OAuth flow and the approval routes is a launch criterion (plan phase 6).

## 15. Module boundaries and clean-code rules

### 15.1 Layout

```text
apps/api/src/
  mcp.ts                              doxa-mcp Worker entry
  mcp/
    request-context.ts                McpRequestContext: actor, services, limiter, audit
    server.ts                         createDoxaMcpServer
    scope-precheck.ts                 Mcp-Method / Mcp-Name step-up
    tool-definition.ts                McpToolDefinition, defineMcpTool
    tool-runner.ts                    runTool pipeline
    errors.ts                         mapToolError
    rate-limit.ts                     limits by cost
    activity.ts                       activity writer
    tools/
      index.ts                        TOOLS
      account/  projects/  docs/  branches/  site/  publish/  requests/  domains/  generation/
    resources/
      index.ts  pages.ts  site-config-schema.ts  mdx-reference.ts
  services/
    agent-access/
      actor.ts                        Actor, builders, editOriginFor
      scopes.ts                       expandScopes, SCOPE_CAPABILITIES
      capabilities.ts                 CAPABILITIES
      project-access-policy.ts        ProjectAccessPolicy, AccessDecision
      owner-project-access-policy.ts  v1 implementation
    agent-actions/
      action-definition.ts            AgentActionDefinition and related types
      registry.ts                     AGENT_ACTIONS, defineActionRegistry
      actions/                        one file for each action
      policy/
        approval-policy.ts            ApprovalMode, ApprovalPolicySource, resolver
        platform-overrides.ts         PlatformOverrideSource and its constant
      gateway.ts                      AgentActionGateway
      approval-service.ts             list, get, approve, reject, cancel, cron sweeps
      rpc.ts                          AgentActionsApi WorkerEntrypoint
    oauth/
      authorization-server.ts         createAuthorizationServer, isOAuthProviderPath
      authorize-handler.ts            GET /oauth/authorize
      consent-service.ts              pending consents, approve, deny
      grants-service.ts               list and revoke
      token-validator.ts              OAuthTokenValidator WorkerEntrypoint
    generation-start.ts               GenerationStartService
  repositories/
    agent-approval-requests.ts        store interface + Drizzle implementation
    agent-activity.ts                 store interface + Drizzle implementation
  routes/
    agent-access.ts                   consent and grants routes
    approval-requests.ts              approval routes
packages/contracts/src/
  agent-access.ts                     scopes, grant props, consent and grant DTOs
  approval-requests.ts                request DTOs, statuses, action kinds for the UI
```

### 15.2 Dependency rules

- `mcp/tools/**` must not import `DocsBranchPublish`, `DocsBranchHistory`, `DocsDomainLifecycleService`, `deleteProject`, `createExampleProject`, or `GenerationStartService`. An architecture test scans the imports.
- `mcp/**` must not import `@doxahq/auth`.
- Only `agent-actions/actions/**` call side-effect services for actions.
- Only `agent-access/actor.ts` builds an actor. Only a `ProjectAccessPolicy` builds an `AuthorizedProject`.
- Services receive stores through constructor dependencies. A service creates a binding or a database client only in its `fromEnv` factory.

### 15.3 Types

- Derive DTO types from Zod schemas in `packages/contracts`.
- Use discriminated unions for results and states: `AccessDecision`, `PerformActionResult`, `Freshness`, `ActionToolOutput`, `GenerationStartOutcome`, the request status.
- Use branded IDs for `UserId`, `ProjectId`, and `ApprovalRequestId`.
- No `any`. No `as` to silence the compiler. No non-null assertions (`!`). Narrow with checks.

### 15.4 General rules

- One responsibility for each file. As a guide, split a file that goes past 300 lines, and review a function that goes past 40 lines.
- No duplicated logic. Allowed and approved actions share `execute`. All tools share `runTool`. All errors go through `mapToolError`.
- Transactions live in repositories.
- Pure modules have no I/O: `scopes.ts`, `approval-policy.ts`, `mapToolError`, the freshness comparisons, and the merge patch helper.
- Comments explain why, not what.

## 16. Observability

- Each tool call logs one JSON line: `requestId`, `tool`, `userId`, `clientId`, `projectId`, `outcome`, `errorCode`, `durationMs`, `policySource`.
- Never log tokens, props, page content, or site config content.
- `agent_activity` holds the durable record of writes and decisions.
- Worker observability stays on for `doxa-mcp`.

## 17. Infrastructure and configuration

Each item needs approval before it changes.

| Item | Detail |
|---|---|
| Worker | `doxa-mcp`, config `apps/api/wrangler.mcp.json`, `main: src/mcp.ts`, flags `nodejs_compat` and `global_fetch_strictly_public`. |
| Route | Custom domain `mcp.doxa.so`. |
| Placement | `aws:us-east-1`. |
| Bindings for `doxa-mcp` | `AUTH_SERVER` (service `doxa-api-production`, entrypoint `OAuthTokenValidator`), `PLATFORM_ACTIONS` (service `doxa-api-production`, entrypoint `AgentActionsApi`), `HYPERDRIVE` and `HYPERDRIVE_CACHE_DISABLED` (same IDs as the API), `DOCS_BUCKET`, three rate limit bindings. |
| Vars for `doxa-mcp` | `MCP_RESOURCE_URL`, `OAUTH_ISSUER`, `WEB_ORIGIN`, `DOCS_BASE_DOMAIN`, `DOCS_RENDERER_BASE_URL`. |
| KV | New namespace for `OAUTH_KV`, bound to `doxa-api`. |
| Vars for `doxa-api` | `OAUTH_ISSUER`, `MCP_RESOURCE_URL`. |
| Validation | `scripts/validate-production-config.mjs` checks the MCP config: name, main, placement, flags, the Hyperdrive IDs equal the API IDs, the service bindings, and the rate limit bindings. |
| Deploy | `deploy:mcp` in the root `package.json`, after `deploy:api`. Add it to `.github/workflows/deploy-production.yml`. |
| Local dev | `doxa-mcp` on port 8791 (inspector 9233), started by `scripts/dev-env.sh`. |

## 18. Verification

### 18.1 Pure units (table-driven)

- `expandScopes` and `SCOPE_CAPABILITIES`: every scope, every implication, no upward implication.
- Effective capabilities: owner, non-owner, agent with each scope, project inside and outside the grant.
- `ApprovalPolicyResolver`: default only, override inside `allowedModes`, override outside `allowedModes`, order of sources.
- `defineActionRegistry`: duplicate kinds fail.
- `mapToolError`: one case for each row of section 9.6.
- Freshness comparisons for each action.
- The merge patch helper: RFC 7396 examples.
- The login redirect sanitizer: the cases of section 6.6.

### 18.2 Registry consistency

- Every tool name is unique and matches `^[a-z][a-z0-9_]{2,63}$`.
- Every tool scope is in `OAUTH_SCOPES` or null.
- Every tool with `action` refers to a registered action, and its scope equals the action scope.
- Every action has a review surface renderer in the web app (a typed exhaustive map).
- The import boundaries of section 15.2.

### 18.3 Service tests (in-memory stores)

- Gateway: allow, require approval, deny, an idempotent repeat, a replaced pending request.
- Approval service: approve, reject, cancel, expire, stale on approve, a double approve, interrupted execution.
- Consent service: approve, deny, single use, scope subset, project ownership.
- `GenerationStartService`: each outcome. The current route tests pass with no change.
- `applyEdits` with `expectedRevision`: match and mismatch.

### 18.4 MCP tests

- Drive the MCP handler with real JSON-RPC requests and a fake `ctx.auth`.
- For each tool: success, `not_found` for another user's project, `project_not_in_grant`, missing scope.
- The scope pre-check returns `403` with the full scope set.
- A 2025-style request (with `initialize`) works through the legacy lane.
- Approval tools: a pending result, then a completed result.

### 18.5 HTTP tests

- Consent and grants routes: no session gives `401`, wrong origin gives `403`, another user's consent fails.
- Approval routes: no session, another user's request, an agent actor rejected, SSE stages on approve.
- The dispatcher sends provider paths to the provider and everything else to Hono.

### 18.6 Dashboard tests

- Consent page, connected agents, approval resolver, publish menu approval view, approval page, typed confirmation.
- `pnpm --filter @doxahq/web typecheck` and `pnpm --filter @doxahq/web build`.

### 18.7 Manual client checks

Connect each client to a local or staging server and run the main workflow (find a project, branch, edit, preview, publish, approve):

- MCP Inspector
- Claude Code and Claude Desktop
- Cursor
- ChatGPT (developer mode connectors)

### 18.8 Commands

```bash
pnpm --filter @doxahq/contracts test
pnpm --filter @doxahq/db test
pnpm --filter @doxahq/api test
pnpm --filter @doxahq/api typecheck
pnpm --filter @doxahq/web typecheck
pnpm --filter @doxahq/web build
pnpm db:check
node --test scripts/validate-production-config.test.mjs scripts/docs-placement-config.test.mjs
pnpm --filter @doxahq/docs-artifact-fixtures test
pnpm --filter @doxahq/docs-runtime test
pnpm --filter @doxahq/docs-template test
```

The three compatibility suites must stay green. This spec does not change the read side, so a red suite means an unintended change.

## 19. Documentation

- Add `docs/current/mcp-server.md`: purpose, architecture, tools, auth, limits, local dev, runbook.
- Add `docs/current/agent-actions.md`: actions, approval policy, lifecycle, extensibility recipes.
- Link both in `docs/current/README.md`.
- Update `docs/current/docs-branching.md` (section 10.7).
- Add the MCP Worker to `docs/diagrams/high-level-system.mmd` and to the copy in `docs/diagrams/README.md`.
- Add `doxa-mcp` to "Main entrypoints" in `AGENTS.md`.
- Update `docs/testing-strategy.md` with the new test groups.
- Add user guides for connecting each client. Put them in the official Doxa docs site.

## 20. Decision record

| Date | Decision | By |
|---|---|---|
| 2026-10-04 | Separate `doxa-mcp` Worker. | User |
| 2026-10-04 | Workers OAuth Provider v1. Better Auth unchanged. | User |
| 2026-10-04 | The user picks projects at consent, or selects all projects. | User |
| 2026-10-04 | No teams in v1. The code is ready for teams. | User |
| 2026-10-04 | Gated in v1: publish, restore, domain add and remove, project delete, generation start. The list can change. | User |
| 2026-10-04 | Gates are configurable in code and later by users. | User |
| 2026-10-04 | Approval in the dashboard: publish menu for publishes, approval page for the rest. | User |
| 2026-10-04 | Agents poll approval requests. No Tasks extension until the SDK supports it. | Spec |
| 2026-10-04 | The MCP Worker has no secrets. Actions run in `doxa-api`. | Spec |

## 21. Follow-ups outside this spec

- Teams, members, and roles. Move the current dashboard routes to the access layer.
- Settings UI for the approval policy (section 8.9).
- Personal access tokens for headless agents and CI.
- The MCP Tasks extension, when the SDK supports it.
- Per-tool `scopeChallenge`, when `agents` allows SDK 2.1 or later.
- Email or Slack notice for a new approval request.
- MDX check on the dashboard save path.
- Asset upload for agents.
- Erase and discard of agent-created branches by the agent.
- Search over branch content.
- An MCP prompts library for common workflows.
- Code Mode, if the tool count grows past about 40.

## 22. Version roadmap

| Version | Content | Estimate |
|---|---|---|
| MVP | Read tools, branch edits, site settings, approved publish (plan phases 0 to 4, and phase 5 with `docs.publish` only). | About 5.5 weeks, 1 engineer |
| v1 | MVP plus the other actions (restore, domains, project create and delete, generation), the approval page, the load test, the security review, and the launch. This spec. | 7.5 to 10 weeks in total |
| v1.1 | User and project gate settings (section 8.9). An email or Slack notice for a new approval request. | 3 to 5 days for the gate settings. The notice is not estimated. |
| v2 | Teams and roles (a separate spec). Personal access tokens for headless agents. | Not estimated |
| Later | MCP Tasks and per-tool scope challenges (when the SDK supports them), asset upload for agents, search over branch content, Code Mode. | Not estimated |

Two decisions are open for v1.1:

1. Precedence. If a project setting and a user setting disagree, the recommended rule is that the stricter mode wins.
2. Who can edit the gates of a project. Today the owner can. With teams, a new capability (`agent_policy.manage`) gives this right to admins.

## 23. Spike results (2026-10-04)

Plan phase 0 ran two local Workers joined by a service binding. The results change the design in four places.

| Question | Result |
|---|---|
| Versions | `agents` 0.26.0 pins `@modelcontextprotocol/server` 2.0.0 and needs `@modelcontextprotocol/client` 2.0.0 as a peer. `@cloudflare/workers-oauth-provider` 1.2.1. Zod 4 imports from `"zod"`. |
| `authInfo` delivery | `handler.fetch(request, { authInfo })` reaches tools as `context.http.authInfo`. `authInfo.resource` must be a `URL`. `ctx.auth.clientId` is optional, so it needs a fallback. Do not use the callable form `handler(req, env, ctx)`. |
| Config from env | Both provider classes check static options in the constructor. Build each server lazily, memoized in module scope on the env values. |
| Provider paths | `/.well-known/oauth-authorization-server`, `/oauth/token`, `/oauth/register`. Revocation shares `/oauth/token`. The resource server serves `/.well-known/oauth-protected-resource/mcp`, and returns `404` when the request origin differs from the resource origin. |
| Step-up | `insufficientScope()` returns `403` with `WWW-Authenticate: Bearer ... error="insufficient_scope", scope="..."`. The SDK client reports `InsufficientScopeError`. A new grant with the added scope works. |
| 2026 headers | A 2026 request without `Mcp-Method` and `Mcp-Name`, or with a wrong `Mcp-Name`, gets `400` (`-32020`). The header pre-check cannot be spoofed for 2026 requests. |
| 2025 clients | `legacy: "stateless"` serves `initialize`, `tools/list`, and `tools/call` for 2025 protocol versions. Legacy requests skip the header checks. |
| Pending consent | `parseAuthRequest` output survives `JSON.stringify` and a later `completeAuthorization`. A CIMD document that fails to load throws `CimdFetchError`, not `AuthorizationError`. |
| Token format | Access tokens start with `<userId>:`. The user ID is visible in the token. |
| Not checked | A real CIMD flow, MCP Inspector, Claude Code, Cursor. Plan task 6.4 checks them. |

Design changes from the spike:

1. Section 9.1: build `OAuthResourceServer` lazily from the env, and pass `authInfo.resource` as `new URL(ctx.auth.audience)`.
2. Section 6.5: the authorize handler also catches `CimdFetchError` and shows a local error page.
3. Section 9.4: the scope check in the tool runner is mandatory, because legacy requests skip the header check.
4. Section 6.2: revocation uses `/oauth/token`. No separate path exists.

## 24. Implementation notes (2026-10-04)

The v1 code is on the branch `feat/mcp-server`. It differs from the sections above in these places.

| Topic | Change | Reason |
|---|---|---|
| Actions | Two more actions: `domain.check` and `generation.cancel`, both `allow` by default. `check_domain` and `cancel_generation` call them. | They need the Cloudflare API token and the container binding. The MCP Worker holds neither (section 5.2). |
| Action tool output | One object with `outcome` and the fields that it implies, instead of a JSON Schema `oneOf`. | MCP needs an object at the root of an output schema. |
| Reads of `main` | Read tools return the live site on `main`, never the user's unpublished drafts. | Agents work on named branches. The human's drafts belong to the dashboard. |
| Per-page diff | Not built. The publish menu shows the changed pages and the preview URL. | No API returns a page diff between the base version and a branch. A follow-up adds one. |
| Stale publish requests | The publish menu learns that a request is stale from the approve answer or from the cron, not from a revision compare in the browser. | The request DTO does not carry the snapshot. |
| OAuth dispatch | The provider dispatch is the first Hono middleware, not a wrapper around `fetch`. | The same effect: provider paths skip CORS and CSRF. |
| Grant metadata | Grant metadata also holds `grantRef` and `projectScope`. | Grant listings cannot read the encrypted props. Neither value is secret. |
| Local dev | `pnpm dev` starts `doxa-mcp` on port 8791 after the API. `--no-mcp` skips it. | Approved on 2026-10-05. |
| Production | No production Wrangler config, KV namespace, route, or deploy step yet. | Plan phase 6. Each item needs approval. |
