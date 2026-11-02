# Docs content security policy

The docs dispatcher sends a script and frame policy with every docs HTML
response (SEC-023). The code is `apps/docs-dispatcher/src/content-security-policy.ts`.

## How it works

1. Saved and cached HTML is shared by every visitor, so it holds no nonce.
2. For each HTML response, the gateway makes a new nonce and adds it to every
   `<script>` with `HTMLRewriter`.
3. The policy allows only scripts with that nonce. `'strict-dynamic'` lets
   them load the renderer's own chunks.
4. Frames are limited to the `<Embed>` video hosts: `www.youtube-nocookie.com`,
   `player.vimeo.com` and `www.loom.com`. A test keeps this list equal to
   `packages/mdx-runtime/src/embed.ts`.
5. `base-uri 'self'; object-src 'none'` is enforced on every docs response in
   every mode.

## Modes

`DOXA_PROD_DOCS_CSP_MODE` in `apps/docs-dispatcher/wrangler.json`:

| Value | Effect |
| --- | --- |
| `report` (current) | The policy goes in `Content-Security-Policy-Report-Only`. Nothing is blocked. |
| `enforce` | The policy goes in `Content-Security-Policy` and is enforced. |
| `off` (or any other value) | No nonces and no policy. |

## Reports

Browsers send violations to `/__doxa/csp-report` on the docs host. The
dispatcher logs one `docs_csp_report` line for each violation, with the host,
the page path, the directive and the blocked origin. It keeps no query
strings and no full URLs. The endpoint is under the per-IP request limit.

## Moving to enforce

1. Deploy with `report`.
2. Read the `docs_csp_report` lines in the dispatcher logs for a week.
3. If a report shows a script or frame that published pages need, change the
   policy first.
4. Set `enforce` and deploy the dispatcher.
