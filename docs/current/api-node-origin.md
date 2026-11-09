# API on Node: the origin and the thin Worker

Status: in production since 2026-10-24. `doxa-api-production` is the thin
Worker, and the API runs on ECS. The migration spec, with the decisions and
the cost comparison, is kept outside this repository.
How an operator deploys and runs it: [self-hosting.md](self-hosting.md). Doxa's
own runbook lives in its private ops repo.

## Parts

| Part | Path | What it does |
|---|---|---|
| Node origin | `apps/api/src/runtime/node/` | Runs the same Hono app (`src/app.ts`) as a Node server on 127.0.0.1:8786. Bundled by `apps/api/scripts/node-server.mjs` into `dist-node/server.mjs`. |
| Thin Worker | `apps/api-edge/` | Keeps the name `doxa-api`. Proxies `api.doxa.so`, exposes the 5 RPC entrypoints as forwarders, serves the bridge and sends the cron tick. Reaches the origin through its `ORIGIN` binding. |
| Protocol | `packages/api-bridge/` | Paths, headers, the method lists, the `devalue` codec, `callRemote` and `serveRemoteCall`. Both sides import it. |
| AWS and Cloudflare | `infra/terraform/` | ECS Fargate, ECR, Valkey, the private tunnel and its Workers VPC Service, the deploy role and alerts. See its README. |
| Deploy | `scripts/deploy-api.mjs` (`pnpm deploy:api`) | Builds or reuses the ARM64 image of the commit, rolls the origin out on ECS with the renderer release, then deploys the edge. The renderer release (`pnpm deploy:all --step docs-rendering`) runs it as its last step. |
| Origin only | `scripts/deploy-api-ecs.mjs` (`pnpm deploy:api:ecs`) | Registers a task definition revision with a given image and rolls it out. Also rolls back. |

## Network path

```
production   doxa-api Worker ─ORIGIN binding (Workers VPC Service)─▶ private tunnel
               ─▶ cloudflared in the task ─▶ 127.0.0.1:8786 (Node origin)
development  api-edge in wrangler dev ─fetch─▶ ORIGIN_URL (http://localhost:8786)
```

The origin has no public hostname. The tunnel's only ingress rule answers
404, and the tasks accept no inbound connections. Only Workers of the
Cloudflare account with a binding to the VPC Service can reach the origin.
Workers VPC is in beta (free while in beta) and needs cloudflared over QUIC.

## Protocol

```
edge → origin   header x-doxa-origin-key (ORIGIN_SHARED_SECRET)
  POST /__rpc/:entrypoint/:method   one RPC call of a caller Worker
  POST /__cron                      the 5-minute tick, answered with 202
  anything else                     a public request, proxied as it is

origin → edge   header x-doxa-bridge-key (BRIDGE_SHARED_SECRET)
  POST /__bridge/call/:binding/:method   GENERATION_QUEUE, EMAIL_QUEUE, DOCS_CACHE_INVALIDATOR (invalidate, syncHostnames, getWarmStatus), PRERENDER_QUEUE
  ANY  /__bridge/fetch/AGENT_CONTAINER   a fetch to the agent container
```

- The edge never proxies a public path under `/__`, and it drops the `x-doxa-*`
  headers that a client sends.
- The edge sends the public URL (`x-doxa-public-url`) and the client IP and
  country. The origin rebuilds the request with them, so the API sees
  `https://api.doxa.so/...` and `cf-connecting-ip`, as in the Worker.
- The edge also sends the client's upper-tier cache pool
  (`x-doxa-client-region`, one of the eight `WarmPool` names), from
  `warmPoolForLocation(request.cf)` in `@doxahq/contracts/docs-warm-region`.
  It sends no header when the pool is unknown. The origin keeps the header
  under the same name only when it names a known pool. The API reads it with
  `readClientWarmPool` (`apps/api/src/http/client-region.ts`): a publish,
  restore or approve request puts the pool first in the regional warm job
  (M45), and `GET /projects/:projectId/warm-status` returns it as
  `clientRegion`. When the API runs as a Worker, the helper reads
  `request.cf` and never the header.
- `DOCS_CACHE_INVALIDATOR.getWarmStatus` reads a site's warm progress from
  the docs dispatcher. A dispatcher deployed before that method makes the
  bridge call throw; the API then answers `status: null`.
- RPC values go through `devalue`: `Date`, `Map`, `Set`, `undefined`, `BigInt`
  and typed arrays survive. A thrown error keeps its name and message, as with
  Workers RPC.
- `API_ENTRYPOINT_METHODS` lists the 42 methods. Tests on both sides check the
  list against the classes. **When you add an RPC method, add it to the list.**

## Security rules

- The origin has no public route. Never add a public hostname, DNS record or
  ingress rule to the tunnel: the edge reaches it only through the `ORIGIN`
  VPC Service binding.
- `resolveOrigin` in `apps/api-edge/src/origin.ts` accepts the `ORIGIN`
  binding, or an `ORIGIN_URL` on loopback (development), never both. Any
  other setup throws, so the origin key never goes to another host. Never
  set `remote: true` on the `ORIGIN` binding: local development would then
  send requests into the production tunnel.
- The Node origin listens on 127.0.0.1 (`HOST`). cloudflared shares the
  task's network, so nothing outside the task can connect.
- The origin answers only requests with the origin key. The one exception is
  `GET /health` without the key: the origin answers it with a fixed body and
  never passes it to the API, so its headers cannot steer a request.
- The edge builds origin URLs by setting the path on the origin base URL.
  Never use `new URL(path, base)`: a path such as `//evil.example/x` resolves
  to another host, and the request would carry the origin key there.
- Keyed calls never follow redirects (`redirect: "manual"`). `fetch` keeps
  custom headers on a redirect, which would send the key to the `Location`.
- The origin drops client-sent `cf-connecting-ip`, `cf-ipcountry`,
  `x-real-ip` and `x-forwarded-for`, and sets the IP and country that the
  edge saw. `x-doxa-client-region` is an edge-only header: the edge drops a
  client-sent copy before it sets its own.
- The API `env` on Node holds only API variables: the server settings (shared
  keys, R2 and Valkey settings) and the `AWS_*` and `ECS_*` task variables
  stay out of it.

## Bindings on Node

| Worker binding | Node replacement |
|---|---|
| `DOCS_BUCKET` (R2) | `S3R2Bucket`: R2 over the S3 API. In development, the local Wrangler R2 state through `getPlatformProxy`. |
| `AUTH_KV`, `OAUTH_KV` | `ValkeyKvNamespace`: KV semantics (TTL, metadata, prefix lists with cursors) on Valkey. ElastiCache Serverless runs in cluster mode, so every key of a namespace carries the hash tag `{<namespace>}`: a MULTI or MGET across slots fails with CROSSSLOT. Run its integration test against Valkey in cluster mode. |
| Queues, `DOCS_CACHE_INVALIDATOR`, `PRERENDER_QUEUE`, `AGENT_CONTAINER` | The bridge to the edge (`bindings/bridge-bindings.ts`). |
| `HYPERDRIVE` | A shared `pg` pool for the process (`usePgPoolProvider` in `@doxahq/db`). |
| `ctx.waitUntil` | `BackgroundTasks`. SIGTERM waits up to `SHUTDOWN_GRACE_MS` (110 s). |
| `caches.default` | None. The code already works without it. |
| `cloudflare:workers` | `runtime/node/workers-shim.ts`, through the build alias. |
| `IMAGE_COMPRESSOR`, `SVG_CLEANER` (no Worker equivalent) | `runtime/node/image-processing/`: `sharp` and the SVG cleaning, one child process for each job. See [mcp-server.md](mcp-server.md#image-compression). |
| `global_fetch_strictly_public` | `strict-public-fetch.ts`: every `fetch` refuses private, loopback and link-local addresses. The OAuth provider needs it for Client ID Metadata Documents. The server checks the guard at start-up and exits if it does not work. Off in development, as in `wrangler dev`. |

## Local development

```sh
pnpm dev --api-node
```

This runs the thin Worker in place of the API Worker on :8787 (with the agent
and email Workers in the same process), the Node origin on :8786 and Valkey
from Docker Compose. The first run writes two random local keys to
`apps/api-edge/.dev.vars`. The origin reads the API variables from
`apps/api/wrangler.json` and `apps/api/.dev.vars`, as `wrangler dev` does.

To run the origin image locally with `docker run -p 8786:8786`, set
`HOST=0.0.0.0`. The default, 127.0.0.1, refuses connections from outside the
container.

Integration tests of the S3 and Valkey adapters run when their servers are set:
see `apps/api/tests/runtime/node/bindings.integration.test.ts`.

## Cutover and rollback

The move from the full API Worker happened on 2026-10-24. Login sessions and
MCP OAuth grants stayed in Workers KV, and the origin started with an empty
Valkey, so every user signed in again once. Decided: no data copy.

- Origin: `pnpm deploy:api:ecs --revision <task-definition-arn>`. Every
  deploy prints the ARN of the revision before it.
- Edge: `pnpm --filter @doxahq/api-edge exec wrangler rollback <version-id> --env production`.
  The last full API Worker version still has its KV, R2 and Hyperdrive
  bindings, so a rollback to it serves without the origin. The operator's
  runbook names that version.

## Shared code

`doxa-docs-resolver` and `doxa-mcp` still build from `apps/api` source as
Workers. Keep the shared code Worker-safe: Node-only code stays under
`apps/api/src/runtime/node/`.
