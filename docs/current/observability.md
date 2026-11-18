# Observability

This page describes the uptime monitors, the health routes, and the logs of
the production platform.

## Uptime monitoring

OpenStatus (hosted, Starter plan) checks production every minute from 6
regions. The public status page shows a small set of components. The
monitors and the page live in the OpenStatus workspace, not in this repo.

### Health routes

| Route | Service | Answer |
|---|---|---|
| `GET https://api.doxa.so/health` | API, through the edge Worker and the tunnel to ECS | Fixed `200`. It proves the request path only |
| `GET https://api.doxa.so/health/ready` | API | `200` when Postgres and Valkey answer, else `503`. The body names each check (`ok`, `failed` or `timeout`) and never an error message |
| `GET https://mcp.doxa.so/health` | `doxa-mcp` | Fixed `200`. It reaches no dependency |
| `GET https://docs.doxa.so/.well-known/doxa-health` | Docs renderer | `204` with `x-doxa-renderer-health: ok` |
| `GET https://lexis.doxa.so/v1/search?q=…` with `Origin: https://docs.doxa.so` | Search gateway | `200` with `results`. A real search on the official docs |

`/health/ready` reuses one report for 10 seconds in each process, and each
check has a 3-second timeout. Many monitor calls therefore cost at most one
database query and one Valkey read every 10 seconds.

### Cron heartbeat

After every job of a 5-minute cron tick settles, the Node origin sends one
`POST` to `OPENSTATUS_CRON_HEARTBEAT_URL` with `{ jobs, failed }`
(`apps/api/src/services/cron-heartbeat.ts`). A failed job still counts as a
completed tick, because each job logs its own errors. The monitor goes down
when a tick stops or never starts: a broken edge cron, tunnel, lock, or a
stuck job.

The URL holds the heartbeat token, so it is a secret. On the Node origin it is
an SSM parameter (`/doxa/api/production/OPENSTATUS_CRON_HEARTBEAT_URL`) named
in `api_secret_names`. Without it, nothing is sent.

## Logs

| Source | Where | Kept |
|---|---|---|
| Workers | Cloudflare Workers Logs | 7 days (the Workers Paid limit) |
| Workers | Logpush (`workers_trace_events`) to the R2 bucket `doxa-worker-logs` | 90 days, by an R2 lifecycle rule |
| API on ECS | CloudWatch log group of the service | 90 days (`log_retention_days`) |

Every production Worker sets `"logpush": true`. A Worker sends trace events
only while the account has a Logpush job for the `workers_trace_events`
dataset.

`doxa-try-proxy` keeps traces off. A trace records each outgoing fetch with
its URL, and the query string of a playground call can carry a reader's API
key. Its calls arrive over RPC, so its invocation logs name only the method
and the outcome.
