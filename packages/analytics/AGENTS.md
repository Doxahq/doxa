# Analytics package rules

`@doxahq/analytics` owns every product analytics rule. The plan, with the
reasons for each rule, is the "Doxa PostHog Analytics Plan" doc. The Privacy
Policy (`apps/web/src/components/marketing/legal/privacy-policy-page.tsx`)
describes what this package sends. Change both together.

## What may leave Doxa

- Only events in `src/catalog/events.ts`, with only the properties that each
  event lists. The client drops every other key before a sink sees it.
- Never add a property that can hold customer content: source code, file
  paths, repository or branch names, commit messages, docs text, page titles,
  instructions, AI prompts or answers, MCP tool input or output, tokens of any
  kind, invitee emails, pull request authors, or data about docs site
  visitors.
- Text properties are machine codes (`codeToken`) or a fixed list (`z.enum`).
  A free-text string needs the user's approval and a Privacy Policy change.
- The distinct ID is always the Doxa user ID. The email is a person property
  (`identify`), never an ID. Group keys are billing account and project IDs.

## How to add an event

1. Add it to `PRODUCT_EVENTS` with the narrowest schemas from
   `src/catalog/property-schemas.ts`. Name it `object_action`, past tense.
2. Server events count users and money, so send them from the API, never from
   the browser. A browser event covers only what the server never sees.
3. Add a test that sends it through `createTestProductAnalytics()`.
4. Add it to the event catalog table in the plan doc.

## Code rules

- Feature code calls `productAnalyticsOf(env)` (API) or the web app's typed
  capture helper. It never imports a sink or an SDK.
- `posthog-node` is imported only in `src/providers/posthog`. Only a
  composition root imports `@doxahq/analytics/posthog`: the API Node origin
  (`apps/api/src/runtime/node`), `apps/api/src/services/analytics` and
  `apps/mcp`. `posthog-js` is imported only in `apps/web`.
- Analytics never fails, slows or changes the work that it reports on. Every
  method returns at once; `flush()` never rejects.
- No app that serves customer docs sites loads analytics.
  `tests/import-boundaries.test.ts` checks these rules.
- Never commit a PostHog project key, project ID, personal API key or proxy
  hostname. Production values come from `doxa-ops` (see the root AGENTS.md).
  A missing or unfilled value turns analytics off.
