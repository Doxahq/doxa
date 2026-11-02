# Email

## Purpose

Doxa sends transactional email: team invites, approval requests, generation
results, and custom domain changes. Cloudflare Email Service sends it today.
One provider-neutral interface hides the provider, so a swap to another
provider (for example Amazon SES) changes one adapter and one setting.

The design is in `docs/superpowers/specs/2026-10-07-email-integration-design.md` in the private ops repo (`doxa-ops`).

## Architecture

```
doxa-api ──insert row──► email_deliveries ◄──claim / record (RPC EmailDeliveryApi)──┐
   │                                                                                 │
   └──EMAIL_QUEUE.send({ deliveryId })──► doxa-email-deliveries ──► doxa-email Worker ┘
                                                                     render (react-email)
                                                                     EmailTransport.send
                                                                     └► Cloudflare send_email
```

- Every email starts in `doxa-api`. `doxa-mcp` and `agent-worker` reach the
  hooks through RPC into `doxa-api`, so only `doxa-api` produces email.
- `doxa-api` owns the database. The `doxa-email` Worker
  (`apps/email-worker`) has no database connection. It calls the
  `EmailDeliveryApi` entrypoint of `doxa-api` to claim a row and to record
  the attempt, the same pattern as `agent-worker` with `InternalApi`.
- Only `doxa-email` loads React and holds the `send_email` binding. Its
  bundle is about 2 MB (390 KB gzip). `doxa-api` imports only the parts of
  `@doxahq/email` without React.

## Package `@doxahq/email`

| Entry point | Contents | React |
|---|---|---|
| `@doxahq/email` | `EmailMessage`, `EmailTransport`, failure kinds, Cloudflare and log adapters, provider registry, retry policy (`decideDelivery`), unsubscribe tokens, delivery RPC types, suppression source | No |
| `@doxahq/email/catalog` | Email kinds: name, category, Zod props schema | No |
| `@doxahq/email/mailer` | `Mailer`, react-email templates, `findEmailTemplate` | Yes |
| `@doxahq/email/testing` | `MemoryEmailTransport` | No |

- `EmailTransport.send(message)` returns `SendEmailResult`. It does not throw
  for provider or network errors. Each adapter maps its own error codes to an
  `EmailFailureKind`; the retry policy reads only the kind.
- `EMAIL_PROVIDERS` in `src/provider-registry.ts` maps `EMAIL_PROVIDER` to an
  adapter: `cloudflare` or `log`.
- Message rules (`findEmailMessageProblem`) are the strictest of Cloudflare,
  SES and Resend: 50 recipients, 998-character subject, no line breaks in the
  subject or header values, header names of letters, digits and dashes.

### Templates

Each email kind has three parts:

1. Kind: `src/catalog/<file>.ts`, `defineEmailKind({ name, category, props })`, listed in `EMAIL_KINDS`.
2. Component: `emails/<kind>.tsx`, with `PreviewProps` and a default export.
3. Template: `src/templates/<file>.tsx`, `defineEmailTemplate(kind, { subject, render })`, listed in `EMAIL_TEMPLATES`.

`EMAIL_TEMPLATES` uses `satisfies Record<EmailKindName, EmailTemplate>`, so a
kind without a template does not compile. Components use `EmailLayout` and the
blocks in `src/components/`, with inline styles from `email-theme.ts`.
`EmailLayout` starts with `EmailLogo`: the Doxa mark beside the "DOXA"
wordmark, as on the website. The mark is a PNG at
`https://doxa.so/email/doxa-logo-mark.png`, served by `apps/web` from
`public/email/doxa-logo-mark.png` (80 x 97, drawn at 20 x 24). Sent emails
keep this URL, so never move or delete the file. The wordmark is text, so the
brand still shows when a mail client blocks images. The layout asks mail
clients for light mode only (`color-scheme: light only`).
`EmailAction` and the unsubscribe link accept only `https:` links (and
`http:` to localhost).

Preview the templates with `pnpm --filter @doxahq/email email:dev`
(port 3013).

| Kind | Category | Sent when | Recipients |
|---|---|---|---|
| `team-invite` | transactional | A manager creates an invite with an email address | The address |
| `approval-requested` | approvals | An agent action needs approval (a new request, not a reused one) | Members with `approvals.decide` and the action's capability; not the requester when `require_other_decider` is on. `project.create`: the requester |
| `approval-decided` | approvals | A member approves or rejects | The requester, unless they decided |
| `generation-finished` | generations | A job succeeds (`completeJobOutput`, `publishJobOutput`) or fails (`markJobFailed` that changed the row) | `generation_jobs.requested_by_user_id`; nothing for a Doxabot run without a linked author |
| `domain-status-changed` | domains | A refresh (a person, an agent, or the cron domain check) moves `verificationStatus` to `verified` or `failed` | Members with `domains.write` |

A cancelled generation sends nothing.

### Domain status checks

The `doxa-api` cron (every 5 minutes) runs `DocsDomainStatusChecks`
(`apps/api/src/services/docs-domain-status-checks.ts`). It runs the same
`refreshForProject` as the "Check again" button, so a domain email goes out
without a person looking.

| Domain | Checked |
|---|---|
| `pending`, created less than 24 hours ago | every run (5 minutes) |
| `pending`, older | hourly |
| `verified` | daily |
| `failed`, disabled, Doxa subdomains, not provisioned | never by the cron |

- `docs_domains.last_checked_at` holds the last check by anyone; a manual
  check also resets it. Never-checked domains go first.
- Each run claims at most 20 domains with `FOR UPDATE SKIP LOCKED` and sets
  their `last_checked_at` before the check, so two runs never check the same
  domain, and a domain whose check fails waits for its next turn.
- A failed check is logged as `docs_domain_check_failed` and does not stop the
  batch. Each check is one Cloudflare API call and one routing probe.
- The job does nothing where Cloudflare custom hostnames are not configured
  (local development).
- An email goes out only when the status changes to `verified` or `failed`;
  a check that finds the same status sends nothing.

## Sending streams

Each email intent sends from its own subdomain, so a blocklist or a bad
reputation on one subdomain does not reach the others.

| Stream | Categories | Sender setting | Sender today |
|---|---|---|---|
| `transactional` | `transactional` (invites) | `EMAIL_FROM_TRANSACTIONAL` | `Doxa <no-reply@mail.doxa.so>` |
| `notifications` | `approvals`, `generations`, `domains` | `EMAIL_FROM_NOTIFICATIONS` | `Doxa <no-reply@notification.doxa.so>` |

- `streamOf(category)` (`src/catalog/define-email-kind.ts`) maps a kind's
  category to its stream. `Mailer` picks the sender of that stream.
- `readSenders` requires every stream's setting, so a missing one fails when
  the Worker starts. Invites send from `mail.doxa.so`, notifications from
  `notification.doxa.so`. Both subdomains are onboarded in Cloudflare Email
  Service, with DKIM, a Cloudflare bounce address, and DMARC `p=reject`.
- To give a stream its own subdomain: onboard the subdomain in Cloudflare Email
  Service, set the stream's sender setting, and add the address to
  `allowed_sender_addresses`. No code changes.
- To add a stream (for example `security` for sign-in emails): add it to
  `EMAIL_STREAMS`, map its categories in `streamOf`, add its setting to
  `EmailEnv` and `SENDER_SETTINGS` in `src/config.ts`. The compiler fails until
  `readSenders` returns a sender for it.
- `email_suppressions` is one list for every stream: a bounced address bounces
  on every subdomain.

## Delivery pipeline

- `EmailOutbox.enqueue(kind, props, recipient, dedupeKey)`
  (`apps/api/src/services/email/email-outbox.ts`) checks the props, inserts a
  `queued` row, then sends `{ deliveryId }` to `EMAIL_QUEUE`. A second insert
  with the same `dedupe_key` does nothing. A failed queue send leaves the row
  for the sweeper.
- Notification kinds need a recipient user. The outbox skips the email when
  the user turned the category off, and adds the signed unsubscribe link and
  the `List-Unsubscribe` / `List-Unsubscribe-Post` headers.
- The `doxa-email` queue consumer (`apps/email-worker/src/process-delivery.ts`):
  1. `claimEmailDelivery`: `queued → sending`, a new claim token, `attempts + 1`.
     A suppressed address becomes `suppressed` and returns `null`.
  2. `mailer.sendStored`: checks the props with the kind's schema, renders,
     sends. A missing template or a render error becomes `invalid_message`.
  3. `recordEmailAttempt`: applies `decideDelivery` and returns
     `retryAfterSeconds`. The Worker then calls `message.retry({ delaySeconds })`
     or acknowledges. A lost claim records nothing.
- Retry rules (`DELIVERY_RETRY_RULES`): `rate_limited` 60 s, 8 attempts;
  `unavailable` 30 s doubling to 1 h, 8 attempts; `quota_exceeded` 1 h,
  24 attempts. Other failures are final.
- The `doxa-api` cron (every 5 minutes) runs `EmailDeliverySweeper`: it sends
  `queued` rows due for more than 2 minutes again, and resets `sending` rows
  older than 10 minutes to `queued`. Delivery is at least once: a crash after
  the provider accepted an email can send it twice.
- Notification hooks never fail the action that caused them. Errors are
  logged as `email_notification_failed`.
- Logs hold delivery IDs, kinds, providers and failure kinds, never addresses
  or props.

## Preferences and unsubscribe

- `GET /email-preferences` and `PUT /email-preferences`
  (`{ category, enabled }`) for the signed-in user. A missing row means on.
  The settings page has an "Email notifications" section with one switch for
  each category. Team invites always send.
- An unsubscribe link carries `user`, `category` and
  `token = base64url(HMAC-SHA256(BETTER_AUTH_SECRET, "doxa.email-unsubscribe.v1:" + user + ":" + category))`.
- The email footer links to the dashboard page `/email/unsubscribe`. Nothing
  changes until the person clicks Unsubscribe, so a link scanner unsubscribes
  no one.
- `POST /email/unsubscribe?…` (the `List-Unsubscribe` target, RFC 8058) turns
  the category off without a session. It is exempt from the CSRF check: the
  signed link is the authorization. `GET` on the same path redirects to the
  dashboard page.
- Rotating `BETTER_AUTH_SECRET` makes every sent unsubscribe link invalid.

## Suppressions

- `email_suppressions` is Doxa's own list. A provider result
  `recipient_suppressed` adds the address with reason `provider`.
- The `doxa-api` cron copies the Cloudflare suppression list once an hour
  (`EmailSuppressionSync`) when `CLOUDFLARE_ACCOUNT_ID` and the secret
  `CLOUDFLARE_EMAIL_API_TOKEN` are set. It copies permanent entries only
  (hard bounces, complaints, manual, policy) and only adds addresses.

## Data (migration `0031_email`)

- `email_deliveries`: kind, props, headers, recipient, unique `dedupe_key`,
  status enum `email_delivery_status`, attempts, `next_attempt_at`,
  `claim_token`, provider result columns. Partial index on open rows.
- `email_suppressions`: lowercase email (primary key), reason enum
  `email_suppression_reason`, source.
- `email_preferences`: user + category (primary key), `enabled`.
- `team_invites.invited_email` (nullable).
- Migration `0032_docs_domain_checks`: `docs_domains.last_checked_at`
  (nullable) and the partial index `docs_domains_status_check_idx`.

To find a stuck or failed email, query `email_deliveries` with SQL. The admin
delivery log (`/admin/emails`) was removed on 2026-10-23.

## Configuration

| Worker | Setting | Value |
|---|---|---|
| `doxa-api` | `EMAIL_QUEUE` producer | queue `doxa-email-deliveries` |
| `doxa-api` | `CLOUDFLARE_ACCOUNT_ID`, secret `CLOUDFLARE_EMAIL_API_TOKEN` | optional, for the suppression sync |
| `doxa-email` | `EMAIL_PROVIDER` | `cloudflare` |
| `doxa-email` | `EMAIL_FROM_TRANSACTIONAL`, `EMAIL_FROM_NOTIFICATIONS` | `Doxa <no-reply@mail.doxa.so>`, `Doxa <no-reply@notification.doxa.so>` |
| `doxa-email` | `EMAIL_REPLY_TO` | `support@doxa.so` |
| `doxa-email` | `send_email` binding `EMAIL` | `allowed_sender_addresses: ["no-reply@mail.doxa.so", "no-reply@notification.doxa.so"]` |
| `doxa-email` | service binding `API` | `doxa-api` (production: `doxa-api-production`), entrypoint `EmailDeliveryApi` |

Local development: `pnpm dev` runs `doxa-email` in the same `wrangler dev`
process as `doxa-api`. Wrangler simulates the `send_email` binding: it logs
each email and saves it to a local file. No email leaves the machine.

## Deploy

The order matters: each step needs the one before it.

1. Run the migrations (`0031_email`, `0032_docs_domain_checks`).
2. Create the queue once: `pnpm --filter @doxahq/email-worker exec wrangler queues create doxa-email-deliveries`.
3. Deploy with `pnpm deploy:all` or the Deploy Production workflow (in the ops repo). Both run
   `scripts/deploy-production.mjs`:
   - The `docs-rendering` step deploys `doxa-api` last. The renderer release
     generates its config, `apps/api/dist/wrangler.production.json`, from
     `apps/api/wrangler.json`.
   - The `email-worker` step deploys `doxa-email` next. It binds to the
     `EmailDeliveryApi` entrypoint of `doxa-api-production`.
   - The `web` step deploys the web app, which serves the email logo.

   To deploy `doxa-email` alone, run `pnpm deploy:all --step email-worker`.

`/email/unsubscribe` is not prerendered (`apps/web/vite.config.ts`): it reads
its query and sends its own headers on each request.

## Swap the provider

1. Add `src/providers/<name>/` in `@doxahq/email` with an `EmailTransport`
   (and an `EmailSuppressionSource` for its suppression list).
2. Add its settings to `EmailEnv` and one entry to `EMAIL_PROVIDERS`.
3. Set the new provider's secrets on `doxa-email`, change `EMAIL_PROVIDER`,
   and deploy `doxa-email`. Roll back by setting `EMAIL_PROVIDER` again.

Nothing else changes: the catalog, the templates, the outbox, the retry rules
and the feature code do not know the provider.

## Related files

- `packages/email/`
- `apps/email-worker/`
- `apps/api/src/services/email/`, `apps/api/src/repositories/email-deliveries.ts`,
  `apps/api/src/repositories/email-audience.ts`, `apps/api/src/routes/email.ts`
- `packages/contracts/src/email-preferences.ts`, `packages/contracts/src/email-deliveries.ts`
- `apps/web/src/components/dashboard/settings/email-notifications-section.tsx`,
  `apps/web/src/components/email/email-unsubscribe-page.tsx`
