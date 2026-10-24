# API reference sources and utility containers

The REST API reference of a generated site comes from one of two routes:

- **Spec route.** The repository has an OpenAPI 3.0, 3.1 or 3.2 file, or a
  Swagger 2.0 file. Code reads it, and the spec replaces the REST surface of
  the model completely.
- **Model route.** No spec file passes. The analysis model explores the
  route handlers, and then one model call for each unit of route files
  extracts the endpoints.

Both routes produce the same `RestApiReferenceSurface`, so every later stage
is the same. There is no total page cap on either route: every endpoint gets
its page. Only the editorial budget (24 guide, concept and workflow pages for
`fast-mvp`, 36 for `full-prod`) limits model-written prose pages.

## Where the code lives

| Part | Path |
| --- | --- |
| Job contract and limits | `packages/contracts/src/spec-reader.ts` (`@doxahq/contracts/spec-reader`) |
| Supervisor, job entry, child runner | `packages/utility-kit` |
| The spec-reader job and its image | `apps/utility-jobs/spec-reader` |
| Gate, job registry, job clients | `apps/agent-container/src/utility` |
| Discovery, gates G1 and G3, sanitizer, surface | `packages/agent/src/reference-specs` |
| Route scan, units, extraction, merge | `packages/agent/src/rest-extraction` |

## The spec route

1. **Discovery** (agent container) walks the checkout once with the project
   file listing, which skips `.git`, `node_modules`, build output and symbolic
   links. It also skips test, fixture, example and vendored folders. It keeps
   files with a known name (`openapi.*`, `swagger.*`, `*.openapi.json`) and
   spec files under `api/`, `docs/`, `spec/`, `specs/` and `openapi/`, that
   name an OpenAPI 3.0 to 3.2 or Swagger 2.0 root. Discovery reads the first
   4 KB, then the rest of the file when needed: a spec with sorted keys, such
   as Stripe's, names its version megabytes later. A file over 25 MB stays a
   root when its name or its first 4 KB mark it as a spec, so that gate G1
   reports it. At most 50 roots.
2. **Gate G1** (agent container) reads each file: a relative path inside the
   checkout, no symbolic link on the way, no `.git` segment, `.json`, `.yaml`
   or `.yml`, at most 25 MB, UTF-8 with no NUL byte. The BOM is removed and
   line endings become `\n`. One request is at most 100 MB and 200 files.
3. **The job** (its own container) parses strict YAML 1.2 with the core schema (one
   document, no duplicate keys, no custom tags, at most 50 aliases) or JSON
   that keeps large integers exact. Objects have no prototype and nest at
   most 64 levels. Swagger 2.0 and OpenAPI 3.0 are upgraded to the 3.1 shape
   with `@scalar/openapi-upgrader`. References resolve lazily: only JSON
   pointers inside the sent files, never a URL, an absolute path or an anchor
   name; `$self` is ignored. A reference to a file that was not sent returns
   `need_files`, and the agent container sends another round, at most four.
4. **Gate G2** (the job) checks each operation: method, path, parameter
   locations and names, references. A bad operation is skipped and reported.
   The D9 ceilings reject a spec with more than 10,000 operations or 1,000
   tags. The output of one call is at most 82 MiB: Stripe's 8 MB spec gives
   about 40 MB, because every operation repeats its expanded error schema.
5. **Gate G3** (agent container) checks the job output against a strict Zod
   schema with a cap on every string and list. A result that fails anywhere is
   rejected as a whole.
6. **Sanitizer** (agent container) prints spec Markdown again from an
   allowlist of node types: headings become bold text, raw HTML becomes text,
   images become their alt text, and links keep only `https:`, `http:`,
   `mailto:` and `#anchor` targets. Hidden characters are removed, and known
   key shapes and credential examples become `‹redacted›`.
7. **Surface** (agent container) builds groups from tags, endpoint IDs from
   method and path, and the `source` of the surface: spec versions, files, a
   content hash and the `readerVersion` (the SHA-256 of the job bundle).

The analysis records `referenceSourceReport` (`referenceSourceReportSchema`
in `@doxahq/contracts`): `openapi`, `openapi_partial`, `no_spec`,
`spec_rejected` or `reader_unavailable`, with the spec paths, codes and
counts. The `analysis_complete` event carries the report. Right after it,
the `api_reference_source` event gives one line for the generation log, such
as "Read the OpenAPI spec openapi.yaml (OpenAPI 3.1.0): 612 endpoints." or
"No OpenAPI spec found. The REST reference comes from the code.". Its fields
are flat (`status`, `specs`, `endpoints`, `skipped`, `fileIssues`), so the
log shows each one in full.

### Spec problems that users see

The generation page shows a warning panel when a spec could not be used,
when a file did not parse, or when operations were left out. The generation
detail returns the last report of the run as `referenceSource`, and
`GenerationSpecProblems` in `apps/web` shows it.

- A file that did not parse names its line, its column and the reason. The
  file can be a root or a file that a `$ref` points to. A referenced file
  that fails does not stop the spec route, but the parts it defines are
  missing, so the report lists it in `fileIssues`.
- An operation that gate G2 skipped is listed with its method, path and
  reason. The report lists the first 50 and counts all.
- The job returns only codes: a `SpecFileIssueReason` for a parse problem
  and a `SpecSkipCode` for a skipped operation. Gate G3 accepts only codes of
  the fixed tables in `@doxahq/contracts/spec-reader`
  (`SPEC_FILE_ISSUE_MESSAGES`, `SPEC_SKIP_MESSAGES`,
  `SPEC_REJECTION_MESSAGES`), and the agent container writes the text from
  them. No parser message reaches users, because a parser message can quote
  the file.
- YAML parsing is strict. A file with a YAML error is rejected with its
  location, even when a lenient parser such as js-yaml would read it. A
  per-project setting for loose YAML parsing is a planned task.

## The model route

The model route has no endpoint limit either. The analysis answer is one
model output, so it cannot hold every endpoint of a large API. The agent
container therefore extracts the endpoints file by file after the analysis:

1. **Route scan.** A regex scan finds the source files that register HTTP
   routes, in Express, Hono, Fastify, Koa, NestJS, Spring, FastAPI, Flask,
   Django, Gin, Echo, Chi, ASP.NET, Laravel, Axum and Actix. It keeps Next.js
   route handlers and Rails routes whole. Tests, fixtures, vendored code and
   files over 512 KB are left out. The files that the analysis groups cite are
   added.
2. **Units.** Files become units of at most 40,000 characters of numbered
   lines. A large file splits before a route registration line.
3. **Extraction.** One model call for each unit, at most 400 units and 8 calls
   at a time, with a strict answer schema. If an answer stops at the output
   limit, the unit splits in half, at most four times.
4. **Merge.** Every endpoint goes through the sanitizer and the redactor of
   the spec route. An endpoint joins the analysis group with the same method
   and path, else the group that cites its file, else a group named after its
   first path segment. One method and path appears once.

The surface records `extraction`: the prompt version, the model and the files
that the extraction read. An incremental run reuses the endpoints of an
unchanged file when the prompt version and the model are the same. A file
whose extraction failed keeps the endpoints of the analysis answer. No
extraction call starts after 20 minutes, so the plan step keeps time for the
structure. The route is best effort: the scan cannot prove that it found
every route.

The extraction uses the writer model (decision D7). The agent-worker setting
`DOXA_REST_EXTRACTION_MODEL` can name another model of the same provider.
Usage records show these calls as `rest_extraction` with the `writer` role.

## Utility containers

A utility container does one job for one run, then stops. The spec reader is
the first job. The rules for every job:

- One job, one image, one container class, one entry in `UTILITY_JOBS`. The
  final image stage holds Node, `supervisor.mjs` and `job.mjs` only. A CI step
  (`pnpm --filter @doxahq/job-spec-reader test:image`) fails on any other file.
- The image fixes its job. No request field, argument or environment variable
  selects other code.
- No secrets: `envVars` is empty. The gate passes only `content-type` and
  `content-length`.
- No network: `enableInternet = false`. Inside the container, the job child
  runs with `--permission`, so Node 26 also denies the network, files outside
  the job folder, writes, child processes, code from strings and the
  inspector signal.
- One instance for each run and job (`<job>:<runId>`). The agent container
  calls `/done` after the last call, and the gate calls `destroy()`.
  `sleepAfter` (30 seconds) is a backstop.

The agent container calls `POST http://utility.internal/v1/jobs/<job>/run`
with the `x-doxa-run-id` header. Only the gate answers that host: it is an
`outboundByHost` handler of `AgentContainer` in the Workers runtime. Every
other host of the agent container keeps its normal internet access. The gate
is registered by assignment (`AgentContainer.outboundByHost = ...`), because a
static class field would skip the setter of `@cloudflare/containers` and leave
the handler unregistered.

### Local development

`pnpm dev` starts the agent container with `apps/agent-container/scripts/dev.sh`.
The script builds the agent and the job bundle, then builds the job image
(`pnpm --filter @doxahq/job-spec-reader image`, tag `doxa-spec-reader:dev`).
When Docker runs, the spec reader uses `DOXA_UTILITY_MODE=docker`; without
Docker it falls back to `local`. Set `DOXA_UTILITY_MODE` to choose the mode.

| `DOXA_UTILITY_MODE` | Behavior |
| --- | --- |
| unset or `container` | Calls the job through the gate (production). |
| `docker` | Runs the job image on local Docker, one container for each run. |
| `local` | Runs `apps/utility-jobs/spec-reader/dist/job.mjs`, or `DOXA_SPEC_READER_BUNDLE`, as a child process with the same flags. |
| `off` | No spec route; the model route runs. |

The `docker` mode copies the production setup (`LocalJobContainer` in
`apps/agent-container/src/utility/docker-job.ts`):

- The job container runs on an internal Docker network of its own, so it
  has no internet. It is read-only, has no capabilities and no environment,
  and has 1 GiB of memory, the size of the `basic` instance.
- Docker cannot publish a port of a container on an internal network. A
  relay container (the same image, running a small Node TCP relay) forwards
  one port of `127.0.0.1` to the job, as the gate does in production.
- The containers start on the first call of a run. `done` removes both
  containers and the network. Every object has the label
  `doxa.utility.run`, and `dev.sh` removes the ones that a stopped dev
  server left behind.

`DOXA_SPEC_READER_IMAGE` selects another image tag. The production agent
container image does not contain `apps/utility-jobs`.

### Add a utility job

1. Write the job as a pure function from input bytes to an outcome, in
   `apps/utility-jobs/<job>/`.
2. Put its contract in `packages/contracts` and check every result in the
   agent container.
3. Copy the two-stage `Dockerfile` and the image check script.
4. Add the container class, the binding and a migration in
   `apps/agent-container/wrangler.json`, in both environments.
5. Add the registry entry with its limits.
6. Add threat fixtures for the new input before the first deploy.

## Write stage at scale

Template-rendered pages (REST endpoint pages) make no model call. The worker
writes them in template groups of up to 500 pages
(`MAX_TEMPLATE_WRITE_GROUP_PAGES`) with a 10-minute step timeout
(`TEMPLATE_PAGE_BATCH_TIMEOUT_MS`) and no writer slot. The container accepts
a group larger than `MAX_WRITE_GROUP_PAGES` only when every page is
template-rendered. The planner and review prompts show one line for each
endpoint group, and the review needs no decision for these pages. Writer
prompts cap the API inventory at 24,000 characters.

Each endpoint page carries `factsHash`, the hash of every fact the template
renders. A template page is written again only when its page input hash
changes, so a spec edit rewrites only the endpoints that changed. A change to
a spec file of the published REST reference, or any spec file that
discovery finds in the checkout, counts as structural and patches the
reference sections.

Reference pages keep their published IDs, so routes stay stable. One
exception: an ID that is only an old collision mark (`<section>-<id>`, as
in `rest-api-get-v1-projects`) gets its plain ID back when the structure is
planned again from the start (`dropCollisionMarks` in the structure
runner). A structure patch, as in a normal PR preview, never changes a
published route.

The endpoint template (`rest-endpoint-template-v4`):

- builds example bodies in the real shape from the field paths
  (`data[].id` becomes `{"data": [{"id": …}]}`), with typed numbers,
  booleans and `null` (`rest-json-example.ts`);
- sends the credential in every request sample: `Authorization` for
  bearer, Basic and OAuth 2, and the named header, query parameter or
  cookie for an API key;
- writes no filler text: a field or parameter without a description shows
  its type and example only, and an operation without a description has no
  intro paragraph.

## Node 26

The agent container and the job images run `node:26-slim`, the latest Node 26
release. Node 25 and later do not ship Corepack, so the images install the
pnpm version of the root `packageManager` field with npm. The agent process
runs with `NODE_OPTIONS=--disable-sigusr1`. After Node 26 becomes LTS on
28 October 2026, pin the LTS version by digest in every image.
