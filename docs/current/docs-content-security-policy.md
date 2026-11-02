# Docs content security policy

The docs dispatcher sends a script and frame policy with every docs HTML
response (SEC-023). The code is `apps/docs-dispatcher/src/content-security-policy.ts`.

## How it works

1. Saved and cached HTML is shared by every visitor, so it holds no nonce.
2. For each render, the renderer makes a new random mark. It writes the mark in
   the `data-doxa-script-mark` attribute of `<html>`, and in the `nonce`
   attribute of each script that it writes (`apps/docs-template/src/lib/script-mark.ts`).
3. For each HTML response, the gateway makes a new nonce. With `HTMLRewriter`,
   it reads the mark from the first `<html>` tag, gives the nonce to the marked
   scripts, removes the `nonce` from all other scripts, and removes the mark.
4. The policy allows only scripts with that nonce. `'strict-dynamic'` lets
   them load the renderer's own chunks.
5. Frames are limited to the `<Embed>` video hosts: `www.youtube-nocookie.com`,
   `player.vimeo.com` and `www.loom.com`. A test keeps this list equal to
   `packages/mdx-runtime/src/embed.ts`.
6. `base-uri 'self'; object-src 'none'` is enforced on every docs response in
   every mode.

## Why page content cannot copy the mark

Page content is fixed before the render starts, and each render has a new mark.
So page content cannot hold the mark of its own render. A mark that a person
reads from saved HTML gives no access, because that HTML cannot change.

The first `<html>` tag comes before all page content, so page content cannot
name a different mark.

## HTML from before the marks

Saved and cached HTML from an earlier renderer has no mark. Its scripts must
still run, so the gateway gives the nonce to every script of that HTML. This
HTML has the same protection as before the marks. Page content cannot remove the
mark from new HTML, so new HTML never gets this treatment.

## Modes

`DOXA_PROD_DOCS_CSP_MODE` in `apps/docs-dispatcher/wrangler.json`:

| Value | Effect |
| --- | --- |
| `report` (current) | The policy goes in `Content-Security-Policy-Report-Only`. Nothing is blocked. |
| `enforce` | The policy goes in `Content-Security-Policy` and is enforced. |
| `off` (or any other value) | No nonces and no policy. The mark stays in the HTML. This is safe, because the mark of finished HTML gives no access. |

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
