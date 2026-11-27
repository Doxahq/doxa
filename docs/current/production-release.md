# Production releases: stage, flip, watch

A production deploy is a release. Every service uploads its new version
first, and no version gets traffic. When all versions are uploaded, the flip
serves them together, in about 30 seconds. Before releases, the API changed
about 10 minutes before the Workers that call it.

The code: `scripts/deploy/release.mjs` (the commands), `scripts/deploy/lib/release/` (the
rules) and `scripts/deploy/deploy-production.mjs` (the order). The operator's Deploy
Production workflow runs the same steps.

## The steps

| Step | Command | What it does |
|---|---|---|
| `release` | `release.mjs init` | Starts the release: a manifest with the release ID (the 12-character commit) and the contract check. |
| stage steps | `release.mjs stage <service>`, `deploy-renderer.mjs --stage`, `deploy-api.mjs --stage` | Each step uploads its Worker with `wrangler versions upload`. The version gets no traffic. The manifest records the new version and the version it replaces. |
| `api` | `deploy-api.mjs --stage` | Starts the new image on the idle ECS color and waits until it is healthy. Uploads an edge version that names that color. |
| `flip` | `release.mjs flip` | Serves every staged version with `wrangler versions deploy`, one tier at a time. Then it applies the triggers of the new configs (routes, crons, queue consumers, Workflows), writes the renderer release record and stores the manifest. |
| `verify` | `release.mjs verify` | Smoke-checks production. A failure rolls the release back. |
| `watch` | `release.mjs watch` | Smoke-checks every minute for 15 minutes while the old API color still runs. A failure rolls the release back. Then it stops the old color. |

A failed step before the flip changes nothing that serves traffic, except the
services that deploy live (see below). Fix the cause and resume with
`pnpm deploy:all --from <step>`: the staged manifest stays.

## Tiers

The flip serves the lowest tier first. A service is in the same tier as, or
a higher tier than, every Worker of the release that it binds to, so new code
calls new code. Services that call one another share a tier.
`scripts/deploy/tests/release.test.mjs` checks every service binding against the tiers.

| Tier | Services |
|---|---|
| 1 | docs resolver, playground proxy, agent container (live, see below) |
| 2 | search gateway |
| 3 | docs runtime, shared renderer, API edge (and its origin color), dispatcher, prerenderer |
| 4 | email Worker, MCP Worker, agent Worker |
| 5 | web app |

## What deploys live before the flip

Cloudflare applies some changes only on `wrangler deploy`. The stage step of
such a service deploys it live, and the log says why:

- **The agent container.** Only `wrangler deploy` rolls out a container image.
  It is live from its stage step, so its calls to the API must work with the
  old and the new API.
- **A new Durable Object migration.** The stage step compares the newest
  migration tag of the config with the deployed tag. A Worker with a new tag
  deploys live.
- **A new Worker.** A version can be uploaded only to a Worker that exists.

## The API origin: blue and green

The origin runs as two ECS services (`infra/terraform`). The edge sends all
traffic to the color that its `ORIGIN_COLOR` variable names. The `api` step
starts the new image on the other color, so the flip of the edge version
moves the traffic. Both colors use the same database and Valkey.

The old color keeps running through the watch, so a rollback inside the watch
is instant. Cancel the watch step to stop the hold early: the old color then
keeps running, and the next release starts on it.

The edge sends its release ID to the origin (`x-doxa-release`), and the
origin logs `Release mismatch` once per other release it sees. A few lines
during a flip are normal. The origin puts its release ID on every response,
and the smoke check of `https://api.doxa.so/health/ready` requires the new
one.

## The contract check

The flip serves the API before its callers, and old origin tasks finish their
work against the new edge. For a few seconds, old code calls new code. So the
`release` step compares the RPC entrypoint methods (`API_ENTRYPOINT_METHODS`)
and the bridge methods of this commit with those of the live release, and it
stops when a method or a binding is removed. Additions are safe.

- To remove a method: stop every call to it in one release, and remove it in
  the next one.
- If the failed calls do not matter, pass `--allow-contract-break` (workflow
  input `allow_contract_break`).

The RPC arguments use the `devalue` codec, not shared Zod schemas, so the
check covers methods, not argument fields. A changed argument must stay
readable by the old and the new side for one release.

## Roll back

```sh
node scripts/deploy/release.mjs rollback                 # the release of this deploy, else the live one in the store
node scripts/deploy/release.mjs rollback --release <id>  # the live release, by ID
```

A rollback:

1. starts the old API color with its old revision, if the watch stopped it,
   and waits until it is healthy;
2. serves the previous version of every service, callers first;
3. writes back the renderer release record from before the release;
4. names the previous release live in the store;
5. stops the color of the rolled-back release.

It cannot restore:

- the agent container image: deploy the previous commit with `--step agent-container`;
- a Worker that is new in the release;
- a database migration. Migrations are additive, so the old code still runs.

A version rollback leaves the triggers (routes, crons, queue consumers) of
the new configs in place.

## Where the state lives

| What | Where |
|---|---|
| The manifest of this deploy | `.artifacts/release/manifest.json` (the workflow uploads it as an artifact) |
| The live release | `deploy-releases/current.json` in the renderer code bucket |
| Every release that went live | `deploy-releases/<releaseId>.json` in the same bucket |
| The live API color | the `ORIGIN_COLOR` variable of the live edge version |
| The task count of the live color | SSM `/doxa/api/production/deploy/task-count` (Terraform writes it) |

`node scripts/deploy/release.mjs status` prints the manifest of this deploy.

## Settings

| Setting | Default | Effect |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | required | The account whose deployments the release reads. |
| `DOXA_RELEASE_HOLD_MINUTES` | 15 | The watch time, 0 to 60. |
| `DOXA_RELEASE_SMOKE_URLS` | none | More https URLs to smoke-check, comma-separated, for example a docs page. |
| `DOXA_ALLOW_CONTRACT_BREAK` | `false` | `true` lets the release continue after a failed contract check. |

## Limits

- The flip is not atomic. The Workers of one tier switch within seconds of
  each other, and each tier waits for the one before it.
- Database migrations run before the release, and they must be additive.
- A generation that started on the old agent Worker finishes on old code.
  The queue retries (5 times, 60 seconds apart) cover short gaps.
- The staged versions are not reachable before the flip: production Workers
  have no preview URL (SEC-014). The checks before the flip are the
  Worker startup check of each upload and the ECS health check of the new
  color. The smoke checks run after the flip, and a failure rolls back.
