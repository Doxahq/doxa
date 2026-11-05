# Docs Search

## Purpose

A docs site searches with one of two kinds of provider:

- **Browser search (MiniSearch).** The visitor's browser downloads an index and searches with no network call. It is the default of the free plan, and a paid site can choose it.
- **Remote search (Typesense today).** Each search goes through the search gateway to a provider. It is the default of paid plans.

The pipeline is provider-neutral. A new remote provider needs one name in `@doxahq/contracts/docs-search` and one adapter in `@doxahq/docs-search/providers`. No other part of the pipeline names Typesense, except the two factories that create the adapters (`apps/api/src/services/docs-search/providers.ts` and `apps/search-gateway/src/router.ts`).

## Which Provider a Site Uses

The owner sets `features.searchProvider` in site settings. Unset means the plan's default.

`resolveSearchProvider` in `@doxahq/contracts/entitlements` applies the plan. A choice that the plan does not allow gives the plan's default.

The API checks the plan twice. `assertSearchChoiceAllowed` rejects a new choice on save, for every writer. The index worker applies the plan again when it runs, so a stored choice cannot exceed the plan.

A site that lost its plan keeps its stored choice, but it uses the plan's default. It can still save other settings and publish, because only a new choice is checked, and a publish does not check it. The dashboard shows the default and lets the owner choose any allowed option.

Billing does not store a plan yet. `DOXA_PROD_SEARCH_PAID_PROJECT_IDS` lists the paid projects until it does. Set it on the API and on the MCP Worker. The value `*` marks every project as paid. Production uses `*` until billing separates free and paid, so every site can choose Typesense, and an unset choice uses Typesense. `createSearchPolicyService` is the one function to replace.

`docs_sites.search_provider` and `docs_sites.search_index_key` say what serves searches now. They change only when the index worker finishes for the live version, in one transaction with a cache purge, so the hostname map carries the new values. A restore of a version with a finished result sets them in the publish transaction.

A site with browser search adds no field to its resolution. The resolution is part of every public page cache key, and the warm job starts when it changes, so `withoutSearchTarget` removes these fields from both. A search change never makes pages cold and never starts a warm job.

## Publish

Every production pointer change passes through `withDocsPublicationEffects`, so a dashboard publish, an MCP or agent publish, a generation, a restore and a domain change all reach this code.

1. The publish transaction opens a row in `docs_search_indexes`.
2. After the commit, a deployment with provider credentials starts the index worker without waiting. The scheduler runs every five minutes and finishes anything that stopped. The MCP Worker has no credentials, so it leaves its tasks to the scheduler.
3. The worker claims one task of a live version. It reads `settings/site.json`, applies the plan, and reads `search/index.json`.
4. Before a remote write, the worker records the provider and a new index name on the row. If the row is gone, or the version left production, it does not write.
5. The provider gets an index named `s_{siteId}_{versionId}_{generation}`, where the generation is a full random UUID. A task that still owns its index keeps the name, on a retry or when it repairs a lost index. Any other build gets a new name.
6. The row becomes `ready` (remote) or `skipped` (browser). Only the live version changes what the site serves and retires other indexes.

While the new index builds, the site keeps serving the previous one, so search keeps working, and results can lag the published version. This has a limit. The timer is on the site, in `search_index_stale_since`. It starts at the first sweep that sees the site behind its live version, and a later publish or retry does not restart it. After one hour, the site moves to browser search of the live version, so a removed page does not stay in results. A later build moves it back. Each completed build of the live version clears the timer, and a sweep clears it on any site that is no longer behind.

Gated docs never go to a provider, and preview branches never have a remote index.

### Task States

| Status | Meaning | Next |
|---|---|---|
| `pending`, `running` | Work to do | A result, or a retry with a growing delay, six times |
| `ready` | The remote index exists | `retired` when the site stops serving it and another version is live |
| `skipped` | The version uses browser search | Stays. A restore reuses the result |
| `failed` | Every attempt failed | The scheduler tries again while the version is live |
| `superseded` | The version left production before anything was written | A restore reopens it |
| `retired` | The collector owns its index | A restore builds a new index under a new name |

These migrations assume that no remote search ran before them. That was true when they were written: `docs_search_indexes` held no remote index anywhere. A later change of these states needs its own transition for existing rows.

A row with an `index_key` and any status except `retired` owns an index that may exist. A row without a key never started a write.

### Why a Retired Index Name Is Not Reused

A collector entry names one exact index, and a task never reuses a name that it gave up. New names come from a random UUID. So a delete of an old index cannot hit a newer one, however the two overlap. A restore needs no lock and no waiting period: it builds a new index, and the old one goes to the collector. One index retires once, so its collector entry never has to restart.

### Locks

Every transaction that needs both takes the site row first, then the task row. A publish holds the site row while it moves the pointer, so a worker that holds it knows which version is live. A completion that started before a publish waits for it, and then treats its version as replaced.

### Time Limits

`apps/api/src/services/docs-search/limits.ts` holds these rules, and a test checks how they relate.

- Each provider request ends within 30 seconds.
- A scheduled run ends within 4 minutes, even if a read or a database call never answers. The sweep gets the first minute. The tasks run until 3 minutes after the start, so they get at least 2 minutes. The rechecks get the rest. When a part ends, the run moves on, even if its step still waits on the database, and a later failure of that step goes to the log. After the budget, no provider request can start, because each one takes the same signal.
- At the measured 150 pages per second, a task fits about 27,000 pages. A larger site fails its task until this limit changes, and it moves to browser search when the one-hour limit ends.
- A lease lasts 10 minutes, longer than a run, so two writers never overlap.
- An index waits 15 minutes before the collector deletes it, longer than a run. So a writer that was running when the owner deleted the project has stopped before the delete, and it cannot recreate the index.

### Repair

The scheduler compares live versions with the provider they should use now. It checks up to 50 versions in each five-minute run, the oldest check first, and a version waits at least an hour between checks. A check that fails moves that version to the back of the line. It reopens the task if:

- The plan, the credentials or the access gate changed the wanted provider. A site that lost its plan moves to browser search, and its index goes to the collector. A paid site processed before the credentials existed gets its index.
- The site serves another provider or another index than its live version owns.
- A `ready` index no longer exists at the provider. A provider error does not count as a lost index.
- The task failed.

A plan change or a restore of an older result takes effect after the next check. That is about an hour on a small fleet, and longer above about 600 sites.

## Search Requests

The dispatcher answers `/_doxa/search/v1/config` from the resolved host:

| Mode | When | What the page does |
|---|---|---|
| `browser` | A public site with browser search | Downloads the index, then searches locally |
| `gateway` | A public production site with a remote provider | Sends each search to the gateway |
| `server` | A gated site, or `DOXA_PROD_SEARCH_MODE` is not `on` | Uses the renderer's `/api/search` |

The renderer's `/api/search` stays as the fallback for all modes. It answers while the browser index downloads, if the index is larger than the limit, if the gateway fails, and if a remote index does not exist yet.

## Browser Search Files

The dispatcher serves `/_doxa/search/v1/index?v=` and `/_doxa/search/v1/snippets?v=`. A `v` that is not the live version answers 409 with no cache, and the page asks for the config again past the browser's HTTP cache, so one engine never mixes two versions. The dispatcher splits the version's existing `search/minisearch.json` with `splitCompiledSearchIndex` and caches both files at the edge for 30 days. The writer does not change, so every published version works without a new publish, and the frozen artifact sets stay valid.

Snippet text is about half of the compressed size, so it has its own file. Search starts with the index. Snippets arrive second, and each result shows a summary line until then.

| Pages | Before, gzip | Index, gzip | Index, Brotli | Snippets, gzip |
|---|---|---|---|---|
| 28 | 34 KB | 21 KB | 21 KB | 14 KB |
| 100 | 126 KB | 67 KB | 68 KB | 57 KB |
| 500 | 606 KB | 314 KB | 282 KB | 279 KB |
| 1,000 | 1,228 KB | 645 KB | 548 KB | 564 KB |
| 2,000 | 2,498 KB | 1,346 KB | 1,108 KB | 1,123 KB |

These sizes come from the template pages and synthetic pages grown from them (2026-11-05). An index above 8 MB uncompressed answers 413, and the page uses the renderer.

### Page Load

`search-trigger.tsx` starts the work after the `load` event, in an idle moment, within 1.5 seconds. It loads the dialog code and the index. The page never waits for it.

- MiniSearch code loads only in browser mode.
- `loadJSONAsync` yields while it loads, so a large index does not freeze typing.
- With data saver or a 2G connection, nothing downloads until the visitor moves to the search box. Snippets do not download at all.
- A search with a ready index runs with no debounce.

### Local Development

`pnpm dev` runs no dispatcher, so the renderer answers the same three paths while it runs under Vite (`lib/search/local-search-routes.ts`). It uses the same split code, the same size limit and the renderer's access gate. The build removes this code, because it depends on `import.meta.env.DEV`.

Local sites always use browser mode. The gateway does not run locally, so a site's provider setting has no effect here. To see a slow connection, turn on network throttling in Chrome. The dev server sends these files uncompressed, so the downloads are larger than on a published site.

## The Gateway

`apps/search-gateway` runs at `lexis.doxa.so`. It is the one entry point for remote search, so routing to another provider changes no docs page.

`GET /v1/search?q=...&limit=...` is a plain request with no custom header, so it needs no CORS preflight.

### Security Rules

- The site comes from the browser's `Origin` header, resolved with the dispatcher's sources. No parameter can name a site, version or index. A script can send any `Origin`, but it then reaches only the public text of a public site.
- Only a public production site with a remote provider has a route. The access policy is checked here too.
- The index name is built from validated IDs. The search text travels in a JSON body with fixed settings, so it cannot add a search parameter.
- CORS echoes an origin only after it resolved to a site.
- The Typesense keys are least privilege. Do not give a service the admin key.
  - Gateway: `documents:search` on `s_.*`.
  - API: `collections:create`, `collections:delete`, `collections:get`, `documents:import`, `documents:upsert` on `s_.*`.
- Rate limits: 300 searches per minute per client address, and 6,000 per minute per site.
- Search text is not stored. Usage points hold no query, and Workers invocation logs are off because they contain the URL.
- A provider error reaches the log as a class name only.

The gateway caches each answer for five minutes under the index name, so sites never share an entry, and the CORS header is added per request.

## Garbage Collection

The `docs_search_index` collector deletes one named index, 15 minutes after a task gave it up. A short wait matters, because a retired index still uses cluster RAM. A stale reader gets `index_not_ready` and falls back to the renderer.

The resource must name an index of its own site. The inspect step is a last safety check: an index that the site serves or a task owns stays, and it is checked again in an hour. See [Storage Garbage Collection](storage-garbage-collection.md).

## Usage and Cost

The gateway writes one Analytics Engine point per search to `doxa_search_usage`. The dispatcher writes one per browser index download. The fields are the site, the provider, the outcome, the elapsed time and the response bytes.

The API rolls these up hourly into `docs_search_usage_daily`. It needs `SEARCH_USAGE_ACCOUNT_ID` and `SEARCH_USAGE_API_TOKEN`, a token with the Account Analytics read permission. Each run reads the last 7 days again and overwrites them, so the rollup catches up after an outage of up to 7 days.

`estimateDocsSearchCost` gives a monthly estimate per site: its share of cluster RAM plus bandwidth. Browser search costs nothing per search. Update `DOCS_SEARCH_COST_RATES` when the cluster changes.

`response_bytes` is what the visitor received, in UTF-8 bytes. Only the `answered` rows cost the provider bandwidth, because a `cached` answer never reaches it. The provider's own response is a little larger than the gateway's, so the bandwidth estimate is low.

```sql
-- Searches, bandwidth and index size per site for the last 30 days.
select u.site_id,
       u.provider,
       sum(u.events) filter (where u.outcome in ('answered', 'cached')) as searches,
       sum(u.events) filter (where u.outcome = 'cached') as cached,
       sum(u.events) filter (where u.outcome in ('provider_error', 'index_not_ready')) as failed,
       sum(u.response_bytes) as delivered_bytes,
       sum(u.response_bytes) filter (where u.outcome = 'answered') as provider_bytes,
       sum(u.elapsed_ms_total) / nullif(sum(u.events), 0) as average_ms,
       max(i.indexed_bytes) as indexed_bytes
from docs_search_usage_daily u
left join docs_sites s on s.id = u.site_id
left join docs_search_indexes i
  on i.site_id = u.site_id and i.version_id = s.published_version_id
where u.day >= current_date - 30
group by u.site_id, u.provider
order by searches desc nulls last;
```

## Measured Capacity

Measured on a 0.5 GB Typesense node on 2026-11-05, with synthetic pages of 3.05 KB of searchable text. The node has 419 MB of RAM, and the system uses about 175 MB of it. Each collection per version used 7.3–11.5 KB of RAM per page. Server search time was 1–2 ms at 10,000 pages. About 25–39 customers of 500 pages fit on this node. A site with more text per page needs more. Each publish also holds the old index until the new one is ready and 15 minutes have passed, so a site that publishes many times in 15 minutes holds several indexes for that time.

## Settings

| Name | Where | Purpose |
|---|---|---|
| `DOXA_PROD_SEARCH_MODE` | Dispatcher | `on` moves search from the renderer to the browser and the gateway. Off by default |
| `SEARCH_GATEWAY_ORIGIN` | Dispatcher | The gateway origin, for example `https://lexis.doxa.so` |
| `DOXA_PROD_SEARCH_GATEWAY_MODE` | Gateway | `on` lets the gateway answer. Off by default |
| `SEARCH_TYPESENSE_HOST` | Gateway, API | The cluster's HTTPS origin |
| `SEARCH_TYPESENSE_SEARCH_KEY` | Gateway secret | Search-only key |
| `SEARCH_TYPESENSE_WRITE_KEY` | API secret | Index key |
| `DOXA_PROD_SEARCH_PAID_PROJECT_IDS` | API, MCP | Paid projects until billing exists. `*` marks every project |
| `SEARCH_USAGE_ACCOUNT_ID`, `SEARCH_USAGE_API_TOKEN` | API | Usage rollup |

## Rollout Order

The renderer is evergreen, and `features` is a strict schema. Every reader of site config must be live before a site stores `features.searchProvider`. Follow this order. `pnpm deploy:api:ecs` alone is not enough, because the resolver, the MCP Worker and the agent services deploy separately. `scripts/deploy-production.mjs` deploys all of these readers.

1. Run migrations `0041_docs_search` and `0042_docs_search_index_key`.
2. Deploy every reader, with all search modes off:
   - The renderer and docs-runtime.
   - The dispatcher.
   - The private docs resolver (`pnpm deploy:docs-resolver`). The gateway reads the provider from it on a hostname map miss.
   - The MCP Worker (`pnpm deploy:mcp`). Its site config schema must know the new field.
   - The agent container (`pnpm deploy:agent-container`) and the agent Worker (`pnpm deploy:agent-worker`). A generation sends the published site config through both, and both parse it strictly.
   - The API.
   - The dashboard (`pnpm deploy:web`), last. Its control is what saves the field.
3. Deploy the gateway with the `search-gateway` step of `deploy-production.mjs`. The first deploy creates `lexis.doxa.so`. Its host comes from `OPS_SEARCH_TYPESENSE_HOSTNAME` in the ops repo, and its search key is a Worker secret.
4. Create the two Typesense keys. Add the API settings and the paid project list, and add the paid list to the MCP Worker. The API's secret names go in `api_secret_names` in the ops repo. The scheduler indexes paid sites within about an hour.
5. Set `DOXA_PROD_SEARCH_GATEWAY_MODE=on`, then `DOXA_PROD_SEARCH_MODE=on`.
6. Check one site: its config answers `browser` or `gateway`, a search works, and `docs_search_indexes` shows the expected status.

## Not Covered

- Docs chat runs only in the template's own build and reads content with its own tools. When chat comes to platform sites, its retrieval can use a `SearchReader`.
- MCP `search_docs` searches the compiled index directly, because it also searches a branch's unpublished pages. It does not use a remote provider.
