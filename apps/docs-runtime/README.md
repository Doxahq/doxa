# Docs Runtime

`apps/docs-runtime` is the platform content/runtime-source Worker.

It intentionally keeps the existing `@doxahq/docs-runtime` package and Worker
name for now. The user-facing renderer is `apps/docs-template`; this app supplies that renderer with
project-scoped docs data.

## Runtime Source Contract

The production path is:

1. `apps/docs-template` receives a docs page request.
2. Template server code resolves the current project id.
3. Template server code calls this Worker at `POST /runtime-source`.
4. This Worker authenticates the request, resolves the published docs version,
   reads R2 artifacts, and returns JSON runtime data.

Required request shape:

- `Authorization: Bearer <DOCS_CONTENT_TOKEN>`
- `x-doxa-project-id: <project-id>`
- JSON body: `{ "operation": "<runtime operation>", "payload": { ... } }`

The project id is trusted only after this Worker resolves it through the API
service binding. Payload fields cannot change the project or artifact prefix.

## Legacy Preview Route

`/:projectSlug` still renders a small HTML preview from published artifacts. It
is kept for local smoke tests and debugging. It is not the long-term production
renderer for custom docs domains.

With the standard `pnpm dev` stack, use
`http://<project-slug>.localhost:3002` for the current shared renderer. Port
`8788` is the content Worker and legacy debug surface, not the normal docs URL.

## Bindings

- `API`: service binding to `apps/api` `InternalApi`.
- `DOCS_BUCKET`: R2 bucket containing generated docs artifacts.
- `DOCS_CONTENT_TOKEN`: secret used by template server code to call
  `/runtime-source`.
- `DOCS_PUBLIC_BASE_URL`: non-secret public base URL used in fallback runtime
  metadata.
