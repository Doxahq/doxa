# Development

This guide explains how to run the Doxa platform on your computer. For a
production setup, read [self-hosting.md](current/self-hosting.md).

## Workspace

- `apps/web` - migrated `doxa.so` homepage plus the MVP dashboard.
- `apps/api` - Cloudflare Worker API with Better Auth, GitHub, projects, jobs, and publish endpoints.
- `apps/docs-template` - public documentation renderer. It owns the reader-facing UI, MDX rendering, navigation, search, and API reference experience.
- `apps/docs-runtime` - docs content/runtime-source Worker. It serves the
  private `/runtime-source` contract consumed by `apps/docs-template` and keeps a legacy HTML preview route for
  local/debug smoke tests.
- `apps/agent-worker` - queue consumer that writes versioned docs artifacts to R2 and publishes them.
- `apps/agent-container` - Cloudflare container scaffold for repo checkout and filesystem-based agent execution.
- `packages/agent` - shared Doxa documentation-generation agent.
- `packages/auth` - Better Auth runtime/client helpers.
- `packages/db` - Drizzle schema, migrations, and Hyperdrive/pg database client.
- `packages/contracts` - shared API DTOs and Zod schemas.
- `packages/docs-engine` - docs artifact paths and manifest helpers.
- `packages/config` - small shared configuration utilities.

## Stack

- Cloudflare Workers for web/API/docs/job runtimes.
- Cloudflare R2 for generated docs artifacts.
- Cloudflare Queues for MVP generation dispatch.
- Cloudflare Containers for the next repo-clone agent execution path.
- PlanetScale Postgres through Cloudflare Hyperdrive.
- Drizzle ORM with `pg`.
- Better Auth with Google and GitHub OAuth.

## Commands

- `pnpm install`
- `pnpm db:local:up`
- `pnpm db:local:migrate`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm db:generate`
- `pnpm dev`
- `pnpm --filter @doxahq/web dev`
- `pnpm --filter @doxahq/api dev`
- `pnpm dev:docs-template`
- `pnpm --filter @doxahq/docs-runtime dev`
- `pnpm dev:tunnel`

## Local Database

Local development uses Docker Postgres. PlanetScale Postgres is only needed for
preview/production through Cloudflare Hyperdrive.

```bash
pnpm db:local:up
pnpm db:local:migrate
```

Local connection string:

```txt
postgresql://doxa:doxa@localhost:5432/doxa
```

The API Worker uses this local `DATABASE_URL` from `apps/api/wrangler.json`.
Production should use the `env.production.hyperdrive` binding instead.

## Local Environment

Copy the examples before running dev servers:

```bash
cp apps/api/.dev.vars.example apps/api/.dev.vars
cp apps/web/.env.local.example apps/web/.env.local
```

Fill OAuth secrets in `apps/api/.dev.vars`. Real project generation should use
`GENERATION_MODE=container-inline` locally or `GENERATION_MODE=queue` in
staging/production. `GENERATION_MODE=starter-dev` is only for explicit local
smoke tests and must not be used for real projects.

## Local Cloudflare Tunnel

Use a locally-managed Cloudflare Tunnel when testing OAuth through
`https://dev.doxa.so`. This keeps the route table in the project-generated YAML
config and avoids needing a Cloudflare API token for local development.

```bash
cp infra/cloudflared/dev.env.example infra/cloudflared/dev.env
```

Create the local tunnel and write `infra/cloudflared/dev.env`:

```bash
pnpm dev:tunnel:setup doxa-local-dev
```

Point `dev.doxa.so` at the new tunnel:

```bash
cloudflared tunnel route dns doxa-local-dev dev.doxa.so
```

Then start the local services and the tunnel:

```bash
pnpm dev
```

The `pnpm dev` command starts Docker Postgres, the API and generation queue
consumer in one Wrangler multi-worker session, the local Cloudflare Workflow
emulator, docs content runtime, shared docs renderer, local agent container,
web app, and Cloudflare Tunnel with prefixed logs for each service. It uses real
Better Auth sessions by default. Generated docs open at
`http://<project-slug>.localhost:3002`. Use `pnpm dev -- --dev-user` to bypass
auth with a synthetic `local-dev-user`, `pnpm dev -- --no-agent` when generation
is not needed, and `pnpm dev -- --migrate` when the local database needs
migrations.

The generation worker receives only the model provider keys
(`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`) through an ephemeral
`.dev.vars` file derived from `apps/api/.dev.vars`; the temporary worker
configuration is removed when the dev stack stops. Inspect local Workflow runs
at `http://localhost:8787/cdn-cgi/explorer`.

The tunnel script generates `.cloudflared/dev.yml` with API routes going to
`http://localhost:8787` and the hostname catch-all going to
`http://localhost:3001`, so Vite/TanStack dev assets load correctly through the
same `dev.doxa.so` origin. Local tunnels use HTTP/2 by default to avoid QUIC
latency spikes; override `CLOUDFLARED_PROTOCOL` only when testing another
transport intentionally.

For remotely-managed/dashboard tunnels, `pnpm dev:tunnel:sync` can still push
the same ingress shape through the Cloudflare API, but locally-managed tunnels
are the preferred local development path.

## Real Repo Generation

Starter docs remain available only with `GENERATION_MODE=starter-dev` for local
smoke tests. To test the real repo-aware path locally:

1. Start the complete local stack:

```bash
pnpm dev
```

2. Keep the API Worker generation mode in `apps/api/wrangler.json` set to:

```json
"GENERATION_MODE": "queue"
```

3. Fill these local secrets in `apps/api/.dev.vars`:

```txt
OPENROUTER_API_KEY=...   # when DOXA_MODEL_PROVIDER is openrouter (default)
ANTHROPIC_API_KEY=...    # when DOXA_MODEL_PROVIDER is anthropic
GITHUB_APP_ID=...
GITHUB_APP_SLUG=...
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
```

The queue mode exercises the same API → Queue → Workflow → agent-container path
used by Doxabot. The real path uses GitHub App installation tokens for checkout,
calls the local agent container at `http://localhost:8789`, writes normalized
docs artifacts to R2, and publishes by flipping the active docs version.
`container-inline` remains available for isolated container debugging, but it
does not test Doxabot's queue and Workflow control plane.

## Docs Runtime Role

`apps/docs-runtime` intentionally remains the content/runtime Worker for now.
It is not the final user-facing docs renderer. In production,
`apps/docs-template` renders the docs UI and calls
`apps/docs-runtime` through `/runtime-source` to fetch project-scoped content
from R2.

Local development follows the same split: the shared renderer serves
`http://<project-slug>.localhost:3002`, while the content Worker stays private
behind the renderer at `http://localhost:8788/runtime-source`.

The current responsibilities are:

- authenticate runtime-source requests with `DOCS_CONTENT_TOKEN`;
- resolve the requested `x-doxa-project-id` through the API service binding;
- read only the resolved project's published R2 artifact prefix;
- return the JSON runtime-source operations expected by `apps/docs-template`.

The legacy `/:projectSlug` HTML route remains only as a lightweight preview and
debugging surface while the shared template Worker is being wired in.
