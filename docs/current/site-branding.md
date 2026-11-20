# Site Branding Discovery

**Status:** Implemented, not deployed

**Last reviewed:** 2026-11-20

## Purpose

A new docs site starts with the default settings: no logo, no favicon, the
preset colors, and no footer or social links. The branding step of a first
generation fills these fields from the repository and the company homepage,
so the first published site carries the brand of its team.

## When the Step Runs

The agent-worker runs the step `discover site branding` before it assembles
the artifacts of a production run. Both workflow paths run it: the legacy path
and the revision-aware path. Preview runs skip it.

The step runs only when all of these conditions are true:

- The generation context has `brandingEligible: true`. The API sets it in
  `withGenerationSiteConfig` when the site has no publication other than a
  starter publication (`DocsRepository.holdsOnlyStarterContent`). This is
  the same rule that publishes a run directly, without a review. The step
  therefore never changes a site that a person published.
- `DOXA_SITE_BRANDING_ENABLED` is not `"0"`. The step is on by default.

The step is best effort. It has no retries and a 90-second limit. Any error
or timeout keeps the settings of the context, and the generation goes on.

## Sources

The step reads the free sources first. Code: `apps/agent-worker/src/site-branding/`.

| Source | Read through | Gives |
| --- | --- | --- |
| Repository, owner, README, file tree | GitHub API, with the repo-scoped read token (`createRepositoryReadToken`) | GitHub link, private flag, homepage, owner X account, README `<picture>` logos, logo files |
| Homepage | Public fetch from the Worker | Header logo, JSON-LD logo and `sameAs`, favicons, footer link groups, social links |
| Context.dev Brand API | `POST https://api.context.dev/v1/brand/retrieve`, by domain | Logos with light and dark variants, the colors of the chosen logo, social links |

The homepage is the repo `homepage` field, else the organization `blog`
field. The step never guesses a domain from a name. It skips code hosts,
package registries and Doxa hosts (`brandHomepageUrl`).

### Context.dev

Context.dev is off by default. It runs only when both of these are set on the
agent-worker:

- `BRANDING_CONTEXT_DEV_ENABLED=true`
- The secret `CONTEXT_DEV_API_KEY`

Even then, the step calls it only when the free pass found no usable logo, or
found a raster logo whose colors it cannot read. A black-and-white SVG logo
means a black-and-white brand, so it does not cause a call. One call costs 10
credits. The step uses only the logos, the colors of the chosen logo, and the
social links. It does not use the site colors of Context.dev, because the
bake-off showed that they are often UI accent colors.

## Choosing the Logo

The step tries up to six candidates in this order:

1. A README `<picture>` with `prefers-color-scheme` sources (light and dark).
2. The logo in the homepage header: an image or an inline SVG in the home link
   or the header.
3. A logo file in the repo (`logo*.svg`, `logo*.png` and similar, near the root).
4. The JSON-LD organization logo of the homepage.
5. A README image whose name or alt text says logo, wordmark or banner.

Each candidate must pass `inspectImage`:

- The bytes must be an image. The type comes from the bytes, not the header.
- A logo must not have a banner shape (aspect ratio above 8 or below 0.33, or
  a raster of 1200 × 400 pixels or larger).
- An SVG must paint something. An SVG that turns paint off at its root and
  depends on the CSS of its page is refused.
- An SVG whose paint is all light is a logo for dark backgrounds. It becomes
  the dark variant, and the search continues for a light logo.

## Choosing the Primary Color

The color comes only from the chosen logo: the most used colored paint of an
SVG logo, or the logo colors that Context.dev gives. If the logo has only
neutral colors, the preset color stays.

The step writes the color for each mode as `theme.tokens.<mode>.primary`,
with a black or white `primaryForeground`. It does this only for a mode where
the color has a contrast of 3 or more against the page background. A light
brand color, such as lime, therefore applies to the dark mode only.

## What the Step Changes

`applyDiscoveredBranding` fills only fields that still hold their defaults:

| Field | Filled when |
| --- | --- |
| `branding.logo.light`, `branding.logo.dark` | Both are empty |
| `branding.favicon` | It is empty |
| `theme.tokens.light/dark.primary` | `theme.primary` is empty and the tokens equal the preset |
| `navbar.github` | It is empty and the repository is public |
| `footer.socials.*` | Each one that is empty |
| `footer.groups` | There are no groups |

The result must pass `siteConfigSchema`. If it does not, the step keeps the
original settings.

## Assets

The worker never writes assets. It sends the bytes to the API RPC method
`storeGenerationSiteAsset({ jobId, kind, bytes })`. The API:

- Takes the project from the job, never from the caller.
- Refuses the call unless the job is active.
- Stores the bytes through `SiteAssetsService.uploadForGeneration`: the same
  SVG cleaning, compression and site quota as a person's upload.

## Network Safety

The homepage is controlled by the customer. All homepage and image reads
therefore run in the agent-worker, never in the API on ECS. `fetchPublic`
allows only `http` and `https` on default ports. It refuses IP literals,
local names and URLs with credentials. It follows at most four redirects, and
it checks each one with the same rules. It reads at most 2 MB of HTML, 512 KB
for a logo, and 128 KB for a favicon.

## Job Event

The step records `site_branding_applied` with the filled fields, the logo and
color sources, the homepage, and the Context.dev use (`disabled`,
`not_needed`, `used` or `no_result`).

## Not Covered

- The local `container-inline` generation mode does not run the step.
- The `ogImage` field stays empty. A marketing OG image is not a docs image.
- The step reads raw HTML. It does not run JavaScript, so it misses headers
  that a script draws.
