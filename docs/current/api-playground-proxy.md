# API playground proxy

"Try it" on an API reference page can send a request in two ways:

- **Proxy (default):** the `doxa-try-proxy` Worker sends the request. The API needs no CORS setup. The reader's key passes through Doxa in memory.
- **Browser:** the reader's browser sends the request. The API must allow CORS. The key never passes through Doxa.

## Request path

1. The panel calls `GET /__doxa/try/config`. The answer gives the mode, the host and a `targetId`. The panel shows no note about the mode or about a preview. It shows a message only when the playground is off. If the host in the answer differs from the page's own base URL, the panel clears the key, disables Send and asks the reader to reload.
2. The panel posts to `POST /__doxa/try` on its own origin. The request holds a method, a path and the `targetId`, and it has no URL or host field. The proxy refuses the send if the `targetId` does not match the current target.
3. `apps/docs-dispatcher/src/try-route.ts` checks the method, `Sec-Fetch-Site`, `Origin` and the content type. It resolves the site from the hostname, then reads `features` from the docs runtime. It never reads the body.
4. `apps/try-proxy` (`TryProxyApi`, service binding only) applies the kill switch, the target rules, the blocklist and the limits. It builds a new URL and new headers, then sends.
5. The answer holds the raw body, and `x-doxa-try-result` holds the status and headers of the target. A response with no such header means that Doxa refused.

The contract is `packages/contracts/src/docs-try.ts`.

## Who decides what

| Decision | Source |
|---|---|
| Target | The owner's `features.apiPlaygroundBaseUrl` for the resolved site and version |
| Transport | The owner's `features.apiPlaygroundTransport`. Unset means the proxy. |
| Kill switch | `DOXA_PROD_TRY_PROXY_MODE` on `doxa-try-proxy`. The value is `all`. `allowlist` also needs `DOXA_PROD_TRY_PROXY_SITE_IDS`, which the config does not set. |
| Host blocklist | `DOXA_TRY_BLOCKED_HOSTS` on `doxa-try-proxy`. A host blocks its subdomains too. |

The owner does not prove control of the target host. The user decided this on 2026-11-03. So the target rules, the limits and the blocklist are the only controls on relay abuse.

## Target rules

`parseDocsTryTarget` accepts `https:` on port 443 and a DNS name with a dot. It refuses credentials, a query string, IP literals in every form, local names and the zones in `DOXA_TRY_RESERVED_ZONES`. A base URL on the docs host or a relative path uses browser mode.

A spike on 2026-11-03 measured what Cloudflare does with a Worker `fetch`:

| Target | Result |
|---|---|
| A name that resolves to a private or metadata address | 530, `error code: 1016` |
| A name with no DNS record | 530, `error code: 1016` |
| `localhost` | 403, `error code: 1003` |
| An IP literal outside Cloudflare | 403, `error code: 1003` |
| `1.1.1.1` and its IPv6 form | 301. The request reached Cloudflare, so the Worker must refuse IP literals itself. |
| A bad TLS certificate | 526, `error code: 526` |

These answers are responses, not exceptions, and every response has `server: cloudflare`. `classifyCloudflareFailure` matches the status and the exact body.

What a target sees:

- `Cf-Worker`: the account's `workers.dev` subdomain in the spike. Check the value in production.
- The Worker's egress address, never the reader's address.
- `Cf-Ipcountry` on a target behind Cloudflare. This is the reader's country.
- `User-Agent: DoxaTryIt/1 (+https://doxa.so/try-it)` and `X-Doxa-Try-Site: <siteId>`.

## Limits

| Limit | Value | Where |
|---|---|---|
| Per site and client | 30 per 60 s | `TRY_CLIENT` |
| Per site | 300 per 60 s | `TRY_SITE` |
| Per target host, across sites | 600 per 60 s | `TRY_TARGET` |
| Per site, per UTC day | 5,000 | `TryBudget`, `DOXA_TRY_SITE_DAILY_LIMIT` |
| Per target host, per UTC day | 50,000 | `TryBudget`, `DOXA_TRY_TARGET_DAILY_LIMIT` |
| Request body | 2 MB | |
| Response body | 10 MB | The stream ends, and the panel says so. |
| Time to first byte | 30 s | |
| Total time | 60 s, or 5 min for event streams | |

The rate limit bindings count per Cloudflare location. Only `TryBudget` counts across all locations. A storage fault in `TryBudget` allows the send, because the bindings still apply.

## Local development

`pnpm dev` runs `apps/try-proxy/dev/gateway.ts` on `127.0.0.1:8792`. It stands in for the dispatcher, which `pnpm dev` does not run. The Vite renderer forwards `/__doxa/try*` to it.

The gateway uses the real route and the real send code in `workerd`, with the limits of `wrangler.json`. It treats each local site as a public production site, so the private site rule does not apply locally. No deploy script uses it. If it is not running, the panel uses browser mode.

Locally, the target sees your own IP address, because `wrangler dev` sends from your machine.

## Operations

Do these steps only with the owner's approval. Each one changes production.

- **Stop all sends:** set `DOXA_PROD_TRY_PROXY_MODE` to `off` in `apps/try-proxy/wrangler.json`. Then, in `doxa-ops`, run `DOXA_PUBLIC_REPO=../doxa-platform scripts/deploy.sh main --deploy-uncommitted-local-changes-to-production --step try-proxy`. Commit the change after that. This needs no renderer build. Panels fall back to browser mode.
- **Block a host:** add it to `OPS_TRY_BLOCKED_HOSTS` in `doxa-ops/wrangler/production-ids.json`. Then, in `doxa-ops`, run `scripts/deploy.sh main --step try-proxy`. This command loads the new value. The value `blocked.invalid` blocks nothing. It is there because the fill step refuses an empty value.
- **Do not run `pnpm deploy:try-proxy` from your working tree.** It stops if `apps/try-proxy/wrangler.json` holds a placeholder, because Wrangler accepts the placeholder as a value and the blocklist then blocks nothing.
- **Find abuse:** the Analytics Engine dataset `doxa_try` holds the site ID, target host, method and outcome (`blob1` to `blob4`), and the status and duration (`double1`, `double2`). It holds no path, query, header or body.

```sql
SELECT blob2 AS host, blob1 AS site, SUM(_sample_interval) AS sends
FROM doxa_try
WHERE timestamp > NOW() - INTERVAL '1' DAY
GROUP BY host, site
ORDER BY sends DESC
LIMIT 50
```

## Before the first production deploy

The next deploy turns the proxy on for all sites, because `DOXA_PROD_TRY_PROXY_MODE` is `all`. The owner chose this on 2026-11-03, with no allowlist phase.

1. Commit `OPS_TRY_BLOCKED_HOSTS` in `doxa-ops/wrangler/production-ids.json`. A missing value stops every production deploy after this branch merges.
2. Commit the `--step try-proxy` step of `doxa-ops/.github/workflows/deploy-production.yml` when this branch merges, not before. The workflow's order check fails if the workflow and the public deploy script do not have the same steps.
3. Publish the page at `doxa.so/try-it`. The `User-Agent` names it. It must say how to block the traffic and how to report abuse.
4. Ask Cloudflare about self-serve terms 2.2.1(j), which bar "other similar proxy services".
5. Submit `doxa.page` to the Public Suffix List.

## After the first production deploy

1. Send a real request from a docs site. The proxy has not run on Cloudflare before this deploy.
2. Check `Cf-Worker` on that request. Rename the `workers.dev` subdomain if the value names a person.
3. Open the panel on a docs site, and read the `docs_csp_report` lines. `DOXA_PROD_DOCS_CSP_MODE` is now `enforce`, and only this deploy runs the new panel under that policy. See `docs-content-security-policy.md`.

Deploy `doxa-try-proxy` before the dispatcher, because a service binding needs an existing Worker. `scripts/deploy/deploy-production.mjs` keeps this order.

## Not in version 1

Multipart upload, an event stream viewer, OAuth, plan-based limits, a Follow control for redirects on the same target, and a right-side panel. Event streams pass through and show as text.
