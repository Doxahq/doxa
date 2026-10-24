# Email integration

Status: Phases 1 to 5 implemented in code on branch `email-integration`. Not deployed: the deployment steps in section 11 need approval.
Date: 2026-10-07.
Current-state documentation: `docs/current/email.md`.
Decision: Doxa sends transactional email through Cloudflare Email Service with a Workers `send_email` binding. One provider-neutral interface, `EmailTransport`, hides the provider. react-email renders the templates. A provider swap (for example, to Amazon SES) is one adapter file, one registry entry, and one configuration change.

Follow the project clean-code skill (`i-coderone-clean-code`) and the repository instructions in `AGENTS.md`.

This spec does not authorize a migration, a new queue, a new Worker deployment, a DNS change, a Wrangler production config change, or a commit. Get explicit approval for each of these.

Doxa has no customers yet. Downtime between phases is acceptable.

## 1. Goal and scope

Doxa must send email to users: team invites, approval requests for agent actions, and generation and domain events. Today Doxa sends no email.

- Cloudflare Email Service is the first provider. It is a native Workers binding, and it costs less than the alternatives at Doxa's volume.
- The provider is a replaceable detail. Feature code, templates, the delivery pipeline, and stored data do not know which provider sends the email.
- react-email is the template system. Designers and developers write emails as React components and see them in a local preview server.

### In scope

- The package `@doxahq/email`: message model, provider interface, Cloudflare adapter, provider registry, configuration, react-email templates, and the mailer (Phase 1).
- A durable delivery pipeline: outbox table, queue, and a dedicated `doxa-email` Worker (Phase 2).
- Team invites by email (Phase 3).
- Approval request notifications and email preferences (Phase 4).
- Suppressions and delivery observability (Phase 5).

### Explicit exclusions

- NO marketing email, newsletters, or bulk campaigns.
- NO inbound email (Email Routing).
- NO attachments. The message model can add them later without a change to the adapters' contract.
- NO change to Better Auth. Sign-in stays social only (Google and GitHub). Magic links and password reset are a separate decision.
- NO provider-hosted templates. Provider template features create lock-in.

## 2. Repository facts

These facts were checked in the code on 2026-10-07.

- No email code exists in `apps/` or `packages/`.
- `packages/auth/src/server.ts` sets `emailAndPassword.enabled: false`. Sign-in uses Google and GitHub only.
- Team invites are links that a manager copies (`docs/current/teams.md`). The doc says: "invites by email are out of scope." The token is an HMAC of the invite ID, valid once, for 7 days (`TEAM_INVITE_TTL_DAYS`).
- Approval requests for agent actions (`apps/api/src/services/agent-actions/`) have no notification. A decider must open the dashboard to see them.
- `doxa-api` runs a cron every 5 minutes (`apps/api/wrangler.json`). The `scheduled` handler in `apps/api/src/index.ts` runs maintenance jobs, for example `DoxabotQueueOutboxPublisher`. That publisher is the existing outbox pattern.
- Two Workers produce events: `doxa-api` (dashboard API) and `doxa-mcp` (agents). Both can cause an email.
- The dashboard primary color is `#3d8bff` (`--dashboard-primary` in `apps/web/src/styles/globals.css`).

## 3. External facts

These facts were checked in the Cloudflare and react-email documentation on 2026-10-07.

### 3.1 Cloudflare Email Service

- Binding: `"send_email": [{ "name": "EMAIL" }]` in the Wrangler file. `env.EMAIL.send({ from, to, cc, bcc, replyTo, subject, html, text, headers, attachments })` returns `{ messageId }`.
- Errors are thrown as objects with `code` and `message`. Codes: `E_VALIDATION_ERROR`, `E_FIELD_MISSING`, `E_TOO_MANY_RECIPIENTS`, `E_TOO_MANY_ATTACHMENTS`, `E_SENDER_NOT_VERIFIED`, `E_RECIPIENT_NOT_ALLOWED`, `E_RECIPIENT_SUPPRESSED`, `E_SENDER_DOMAIN_NOT_AVAILABLE`, `E_CONTENT_TOO_LARGE`, `E_DELIVERY_FAILED`, `E_RATE_LIMIT_EXCEEDED`, `E_DAILY_LIMIT_EXCEEDED`, `E_INTERNAL_SERVER_ERROR`, and seven `E_HEADER*` codes.
- Limits: 50 recipients across to, cc and bcc. Subject 998 characters. Message 5 MiB. Custom headers 16 KB in total, 2,048 bytes for each value.
- Headers use an allowlist. `X-` headers are always allowed. `List-Unsubscribe` and `List-Unsubscribe-Post` are allowed.
- The service has no idempotency key.
- Restrictions on the binding: `allowed_sender_addresses`, `allowed_destination_addresses`, `destination_address`.
- The sender must belong to a domain that is onboarded to Email Service.
- Pricing: Workers Paid plan. 3,000 emails each month are included, then $0.35 for each 1,000. Sends that the API refuses, including suppressed recipients, are not counted.
- New accounts start with a small daily quota that grows with good sending behavior.
- Cloudflare adds hard bounces and complaints to a suppression list. It retries soft bounces itself. With **Drop suppressed recipients** off (the default), a send to a suppressed address fails with `E_RECIPIENT_SUPPRESSED`.
- Local development: `wrangler dev` simulates the binding. It logs each email and saves it to local files. With `"remote": true` on the binding, local code sends real email.

Sources: [Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/), [Send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/), [Limits](https://developers.cloudflare.com/email-service/platform/limits/), [Pricing](https://developers.cloudflare.com/email-service/platform/pricing/), [Suppressions](https://developers.cloudflare.com/email-service/concepts/suppressions/), [Headers](https://developers.cloudflare.com/email-service/reference/headers/), [Local development](https://developers.cloudflare.com/email-service/local-development/sending/).

### 3.2 react-email

- Version 6 ships the components and `render` in one package, `react-email`. `@react-email/components` is deprecated.
- `@react-email/ui` (development only) is the preview server. The CLI command is `email dev`.
- `render(element)` returns HTML. `toPlainText(html)` returns the plain-text part.
- `@react-email/render` has a `workerd` export, so `render` works in a Worker.
- A render Worker bundle is about 1.46 MB minified (406 KB gzip). react-dom is 512 KB, prettier is 260 KB, and html-to-text with its parsers is about 130 KB. We measured this with esbuild and `--conditions=workerd`.

## 4. Design decisions

| ID | Decision | Reason |
|---|---|---|
| D1 | Cloudflare Email Service is the first provider. | Native binding: no API key to store or rotate. Lowest price at Doxa's volume. Same account, same observability. |
| D2 | One interface, `EmailTransport`, is the only seam to a provider. | A swap changes one adapter. Nothing else imports provider code. |
| D3 | A transport returns a result. It does not throw for provider or network errors. | Retry logic reads one typed `EmailFailureKind`. It does not parse provider errors. |
| D4 | Provider-neutral failure kinds decide retries. | The retry policy stays the same after a swap. |
| D5 | The message limits are the strictest of Cloudflare, SES, and Resend. | A valid message stays valid after a swap. |
| D6 | Doxa owns templates (react-email in the repo), not the provider. | Provider templates create lock-in. |
| D7 | The package has three layers: provider (no React), catalog (no React), and mailer (React). | Producers queue email without the 800 KB React render cost. |
| D8 | One dedicated Worker, `doxa-email`, renders and sends. | It keeps React out of `doxa-api` and `doxa-mcp`. Only one Worker holds the `send_email` binding. |
| D8a | `doxa-email` has no database connection. It claims and records rows through the `EmailDeliveryApi` RPC entrypoint of `doxa-api`. | Same pattern as `agent-worker` with `InternalApi`. `doxa-api` stays the only owner of the database. |
| D8b | The sweeper runs in the existing `doxa-api` cron (every 5 minutes), not in `doxa-email`. | The cron already exists and holds the database and the queue producer. Recovery within 5 to 7 minutes is enough. |
| D9 | A Postgres outbox, `email_deliveries`, records every email before it is sent. | No lost email when a queue send fails. Delivery history and suppressions stay in Doxa after a swap. |
| D10 | Delivery is at least once. | Cloudflare has no idempotency key. A rare duplicate email is better than a lost invite. |
| D11 | Inline styles and a light card in every email. No react-email `Tailwind` component. | Many email clients drop `<style>` and force light mode. Inline styles are the most portable choice. |
| D12 | Each sending stream (email intent) sends from its own subdomain. Invites use `mail.doxa.so`; notifications use `notification.doxa.so`. | Bounces, complaints or a blocklist on one subdomain do not affect `doxa.so` or the other streams (section 6.4). |

## 5. Architecture

```
 doxa-api (all hooks; doxa-mcp and agent-worker reach them by RPC)
   │ 1. EmailOutbox: insert email_deliveries row (queued)
   │ 2. EMAIL_QUEUE.send({ deliveryId })
   │ cron every 5 min: EmailDeliverySweeper re-queues stale rows; hourly suppression sync
   ▼
 queue doxa-email-deliveries
   ▼
 doxa-email Worker (no database)
   3. API.claimEmailDelivery(id)        ── RPC ──► doxa-api EmailDeliveryApi (queued → sending)
   4. findEmailTemplate(kind) + Mailer.sendStored: check props, render (react-email)
   5. EmailTransport.send(message)
   6. API.recordEmailAttempt(...)       ── RPC ──► decideDelivery → sent / queued + retry / failed
   7. message.retry({ delaySeconds }) or ack
   │ EMAIL_PROVIDER
   ├──► CloudflareEmailTransport (send_email binding)
   └──► (later) SesEmailTransport (aws4fetch + SES v2 API)
```

### 5.1 Package entry points

| Entry point | Contents | React | Who imports it |
|---|---|---|---|
| `@doxahq/email` | `EmailMessage`, `EmailTransport`, results, adapters, `createEmailTransport`, `EmailEnv`, configuration | No | `doxa-email`, tests |
| `@doxahq/email/catalog` | Email kinds: name and Zod props schema, `EMAIL_KINDS` | No | `doxa-api`, `doxa-mcp` (to queue email) |
| `@doxahq/email/mailer` | `Mailer`, templates, `EMAIL_TEMPLATES`, `findEmailTemplate` | Yes | `doxa-email` only |
| `@doxahq/email/testing` | `MemoryEmailTransport` | No | Tests |

The package sets `"sideEffects": false`. A producer bundle that imports `@doxahq/email` and `@doxahq/email/catalog` has no React module. We measured this with esbuild.

### 5.2 Files

```
packages/email/
  emails/                      react-email components, one file for each kind (preview server reads this folder)
    team-invite.tsx
  src/
    address.ts                 EmailAddress, parseEmailAddress
    message.ts                 EmailMessage, EMAIL_MESSAGE_LIMITS, findEmailMessageProblem
    send-result.ts             SendEmailResult, EmailFailureKind, retry table
    transport.ts               EmailTransport (the provider seam)
    config.ts                  EmailEnv, readSenders (one sender per stream), EmailConfigurationError
    provider-registry.ts       EMAIL_PROVIDERS, createEmailTransport
    providers/
      cloudflare/              CloudflareEmailTransport, error code map
      log-email-transport.ts   writes the email to the log (local runs, CI)
      memory-email-transport.ts  test double
    catalog/                   email kinds (no React)
    components/                EmailLayout, blocks, theme tokens
    templates/                 kind + component + subject = template; EMAIL_TEMPLATES
    mailer.ts                  Mailer.send, Mailer.sendStored
  tests/
```

## 6. Provider abstraction

### 6.1 Contract

```ts
export interface EmailTransport {
  readonly provider: string;            // "cloudflare", stored with each delivery
  send(message: EmailMessage): Promise<SendEmailResult>;
}

export type SendEmailResult =
  | { ok: true; provider: string; messageId: string }
  | { ok: false; provider: string; kind: EmailFailureKind; retryable: boolean; message: string; providerCode?: string };
```

`EmailMessage` has `from`, `to`, `cc`, `bcc`, `replyTo`, `subject`, `html`, `text`, `headers`, and `idempotencyKey`. Addresses are `{ address, name? }` objects. Each adapter converts them to the provider's shape. `html` and `text` are both required, so no provider generates its own text part.

Rules for every adapter:

1. Convert `EmailMessage` to the provider shape in one pure function, for example `toCloudflareBuilder`. Test it.
2. Catch every provider and network error. Map it to an `EmailFailureKind` in one table. Keep the provider code in `providerCode`.
3. Map an unknown code to `unavailable`. A new provider code then causes a retry, not a lost email.
4. Do not export provider types outside the adapter folder. Declare the smallest binding or client interface that the adapter needs.
5. Use `idempotencyKey` when the provider supports it. Otherwise ignore it.

### 6.2 Failure kinds

| Kind | Retry | Cloudflare codes | Pipeline action |
|---|---|---|---|
| `invalid_message` | No | `E_VALIDATION_ERROR`, `E_FIELD_MISSING`, `E_TOO_MANY_*`, `E_CONTENT_TOO_LARGE`, `E_HEADER*` | Mark `failed`. Log an error. It is a code defect. |
| `configuration` | No | `E_SENDER_NOT_VERIFIED`, `E_SENDER_DOMAIN_NOT_AVAILABLE`, `E_RECIPIENT_NOT_ALLOWED` | Mark `failed`. Alert. |
| `recipient_suppressed` | No | `E_RECIPIENT_SUPPRESSED` | Mark `suppressed`. Add to `email_suppressions`. |
| `rejected` | No | `E_DELIVERY_FAILED` | Mark `failed`. |
| `rate_limited` | Yes | `E_RATE_LIMIT_EXCEEDED` | Retry after 60 seconds. |
| `quota_exceeded` | Yes | `E_DAILY_LIMIT_EXCEEDED` | Retry after 1 hour, up to 24 hours. |
| `unavailable` | Yes | `E_INTERNAL_SERVER_ERROR`, unknown code, network error | Exponential backoff from 30 seconds. |

### 6.3 Registry and configuration

```ts
export const EMAIL_PROVIDERS = {
  cloudflare: { create: (env) => new CloudflareEmailTransport(requireSetting(env.EMAIL, "the EMAIL send_email binding")) },
  log: { create: () => new LogEmailTransport() },
} as const satisfies Record<string, EmailProviderDefinition>;
```

| Setting | Kind | Example | Notes |
|---|---|---|---|
| `EMAIL_PROVIDER` | var | `cloudflare` | Required. A key of `EMAIL_PROVIDERS`. Use `log` where no binding exists. |
| `EMAIL_FROM_TRANSACTIONAL` | var | `Doxa <no-reply@mail.doxa.so>` | Required. Sender of invites. |
| `EMAIL_FROM_NOTIFICATIONS` | var | `Doxa <no-reply@notification.doxa.so>` | Required. Sender of notifications. |
| `EMAIL_REPLY_TO` | var | `support@doxa.so` | Optional. |
| `EMAIL` | binding | `send_email` | Required for `cloudflare`. |

`createEmailTransport` and `readSenders` throw `EmailConfigurationError` for a missing or wrong setting. The `doxa-email` Worker builds the mailer once for each request, so a configuration defect fails fast and shows in the logs.

### 6.4 Sending streams

A stream is a group of emails with its own sender address on its own subdomain. The kind's category picks the stream (`streamOf`). A blocklist on one subdomain then leaves the other streams alone.

| Stream | Categories | Subdomain today |
|---|---|---|
| `transactional` | `transactional` (team invites) | `mail.doxa.so` |
| `notifications` | `approvals`, `generations`, `domains` | `notification.doxa.so` |

- Move a stream to its own subdomain with configuration only: onboard the subdomain, set the stream's `EMAIL_FROM_<STREAM>`, and allow the address in the `send_email` binding.
- Add a stream (for example `security` for future sign-in emails) in code: `EMAIL_STREAMS`, `streamOf`, and `SENDER_SETTINGS`. The compiler fails until each stream has a sender.
- `email_suppressions` stays one list for all streams: a bounced address is bad on every subdomain.

## 7. Provider swap

### 7.1 What changes and what stays

| Changes | Stays the same |
|---|---|
| One adapter folder under `providers/` | `EmailMessage`, `EmailTransport`, failure kinds |
| One entry in `EMAIL_PROVIDERS` | Catalog, templates, components, `Mailer` |
| New fields in `EmailEnv` (for example, AWS keys) | Outbox table, queue, retry policy, sweeper |
| Wrangler binding or secrets of `doxa-email` | `doxa-api`, `doxa-mcp`, feature code |
| DNS records of each sending subdomain | Tests of every layer except the new adapter |

### 7.2 Recipe: add Amazon SES

1. Create `src/providers/ses/ses-email-transport.ts`. Implement `EmailTransport` with the SES v2 `SendEmail` API and `aws4fetch`.
2. Write `toSesRequest(message)` as a pure function. Map `idempotencyKey` to nothing, because SES has no idempotency key.
3. Write `classifySesError(error)` with one table. Map `TooManyRequestsException` to `rate_limited` and `SendingPausedException` to `configuration`.
4. Add `AWS_SES_REGION`, `AWS_SES_ACCESS_KEY_ID`, and `AWS_SES_SECRET_ACCESS_KEY` to `EmailEnv`.
5. Add `ses: { create: (env) => new SesEmailTransport(...) }` to `EMAIL_PROVIDERS`.
6. Copy `tests/cloudflare-email-transport.test.ts` to an SES test. Change the fake client and the code table.

### 7.3 Cutover procedure

1. Verify each sending subdomain (today `mail.doxa.so` and `notification.doxa.so`) in the new provider. Add its DKIM and SPF records next to the Cloudflare records.
2. Export the Cloudflare suppression list. Import it into `email_suppressions` and into the new provider.
3. Set the new provider's secrets on `doxa-email`.
4. Change `EMAIL_PROVIDER` on `doxa-email` and deploy it.
5. Send a test invite to a team member. Check the delivery row: `provider` must show the new name.
6. To roll back, set `EMAIL_PROVIDER=cloudflare` and deploy again. Rows keep the provider that sent them.

## 8. Templates with react-email

### 8.1 Three parts of one email

| Part | Location | React | Purpose |
|---|---|---|---|
| Kind | `src/catalog/<kind>.ts` | No | Name and Zod props schema. Producers import it to queue an email with checked props. |
| Component | `emails/<kind>.tsx` | Yes | The design. It has `PreviewProps` for the preview server. |
| Template | `src/templates/<kind>.tsx` | Yes | `defineEmailTemplate(kind, { subject, render })`. |

`EMAIL_TEMPLATES` maps each kind name to its template with `satisfies Record<EmailKindName, EmailTemplate>`. The compiler fails when a kind has no template.

### 8.2 Setup (done in Phase 1)

| Package | Version | Type | Purpose |
|---|---|---|---|
| `react-email` | 6.11.1 (exact) | dependency | Components (`Html`, `Button`, `Text`, …), `render`, `toPlainText`, and the `email` CLI |
| `react`, `react-dom` | ^19.2.7 | dependency | Same major version as `apps/web` |
| `@react-email/ui` | 6.11.1 (exact) | dev dependency | The preview server |
| `@types/react`, `@types/react-dom` | ^19 | dev dependency | Types |

- `packages/email/tsconfig.json` sets `"jsx": "react-jsx"` and includes `emails/`.
- The `doxa-email` Worker's `tsconfig.json` must also set `"jsx": "react-jsx"`. The bundler reads the JSX setting from the Worker's tsconfig. Without it, a render fails with `ReferenceError: React is not defined`. We saw this error with `tsx` and the root tsconfig.
- `pnpm --filter @doxahq/email email:dev` starts the preview server on port 3013.
- `pnpm --filter @doxahq/email email:export` writes static HTML to `.react-email-export/` (ignored by Git).
- Keep `react-email` and `@react-email/ui` on the same exact version. Update both together.

### 8.3 Add a new email

1. Add a kind in `src/catalog/<kind>.ts` with `defineEmailKind({ name, props })`. Add it to `EMAIL_KINDS`.
2. Write the component in `emails/<kind>.tsx`. Use `EmailLayout` and the blocks from `src/components/`.
3. Add `PreviewProps` and a default export to the component.
4. Write the template in `src/templates/<kind>.tsx`. Add it to `EMAIL_TEMPLATES`.
5. Run `pnpm --filter @doxahq/email email:dev`. Check the design at `http://localhost:3013`.
6. Add a test that renders the template and checks the subject, the link, and the text part.

### 8.4 Design rules

- Use `EmailLayout`. It gives the wordmark, the white card, and a footer with the reason for the email.
- Use the blocks `EmailHeading`, `EmailParagraph`, `EmailAction`, and `EmailNote`. Do not add raw colors. Tokens are in `src/components/email-theme.ts`.
- Use one call to action for each email.
- Write the reason line for each email: "You got this email because …".
- Keep copy short. Follow the writing rules of `AGENTS.md`.
- `EmailAction` accepts only `https:` links, and `http:` links to `localhost`. It throws for other links, for example `javascript:`.
- React escapes all text props. Do not use `dangerouslySetInnerHTML`.

### 8.5 Render

`renderEmailTemplate` renders the HTML once with `render`. It derives the text part with `toPlainText`. The subject comes from `template.subject(props)`. `Mailer.sendStored` checks stored props with the kind's schema before it renders.

## 9. Delivery pipeline (Phase 2)

### 9.1 Table `email_deliveries`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, primary key | Also the idempotency key |
| `kind` | text | A kind name from the catalog |
| `props` | jsonb | Checked with the kind's schema at insert and again before render |
| `recipient_email` | text | One recipient for each row |
| `recipient_user_id` | text, nullable | Set when the recipient is a Doxa user |
| `dedupe_key` | text, unique | For example `team-invite:<inviteId>`. A second insert does nothing. |
| `status` | enum | `queued`, `sending`, `sent`, `failed`, `suppressed` |
| `attempts` | integer | Starts at 0 |
| `next_attempt_at` | timestamptz | For retries and the sweeper |
| `provider` | text, nullable | The provider that accepted the email |
| `provider_message_id` | text, nullable | |
| `last_failure_kind`, `last_failure_message`, `last_provider_code` | text, nullable | |
| `created_at`, `updated_at`, `sent_at` | timestamptz | |

| `claim_token` | uuid, nullable | Set by each claim; only its holder records the result |

Table `email_suppressions`: `email` (primary key, lowercase), `reason` (`bounce`, `complaint`, `provider`, `manual`), `source`, `created_at`. Doxa owns this list, so it survives a swap.

Table `email_preferences`: `user_id` + `category` (primary key), `enabled`. A missing row means on.

Column `team_invites.invited_email` (nullable): the address of an invite sent by email.

### 9.2 Producer API

```ts
await emailOutbox.enqueue(teamInviteEmail, props, {
  to: { address: invitee },
  dedupeKey: `team-invite:${inviteId}`,
  recipientUserId: null,
});
```

1. `EmailOutbox.enqueue` checks `props` with the kind's schema.
2. It inserts the row with `status = queued`. It uses the caller's transaction when one exists.
3. After the commit, it sends `{ deliveryId }` to `EMAIL_QUEUE`.
4. If the queue send fails, the row stays `queued`. The sweeper sends it later.

### 9.3 Consumer in `doxa-email`

`doxa-email` runs steps 1, 2 and 6 through RPC (`claimEmailDelivery`, `recordEmailAttempt`) into `doxa-api` (D8a).

1. Claim the row: `UPDATE … SET status = 'sending', attempts = attempts + 1 WHERE id = $1 AND status = 'queued' RETURNING *`. If no row comes back, acknowledge the message and stop.
2. If the recipient is in `email_suppressions`, mark `suppressed`.
3. Find the template with `findEmailTemplate(row.kind)`. Call `mailer.sendStored(template, row.props, { to, idempotencyKey: row.id })`.
4. On `ok`, mark `sent` with `provider` and `provider_message_id`.
5. On a retryable failure under the attempt limit (8), set `status = queued` and `next_attempt_at`. Call `message.retry({ delaySeconds })`.
6. On a final failure, mark `failed` or `suppressed` (section 6.2).

### 9.4 Sweeper (the `doxa-api` cron, every 5 minutes)

- Send rows again when `status = queued` and `next_attempt_at` is more than 2 minutes in the past.
- Set rows back to `queued` when `status = sending` and `updated_at` is more than 10 minutes in the past. This case is a crash after the claim. It can cause a duplicate email (D10).

### 9.5 Observability

- Log one line for each attempt: `deliveryId`, `kind`, `provider`, `status`, `failureKind`, `providerCode`. Do not log addresses or props.
- Use Cloudflare Email Service metrics and logs for delivery after acceptance.

### 9.6 Render cost

We measured the render on Node 24 (V8, the same engine as `workerd`) with the minified Worker bundle:

| Cost | When | Measured |
|---|---|---|
| Load the render bundle | Once for each cold isolate | ~33 ms |
| First render | Once for each cold isolate | ~38–45 ms |
| Render, props check and message check | Each email | p50 ~0.7–1.2 ms, p95 ~1.8–2.3 ms |

At ~1 ms of CPU for each email, rendering costs about 15,000 times less than the Cloudflare price for the email. Pre-rendering to HTML at deploy time saves no money and needs our own escaping, a second template language for conditions and lists, and a build step. Revisit only if the p95 CPU for each email goes above ~10 ms.

## 10. Email catalog roadmap

| Kind | Phase | Trigger | Recipients | Category |
|---|---|---|---|---|
| `team-invite` | 1 (template), 3 (sent) | `POST /teams/:teamId/invites` with an `email` field | The invitee | Transactional |
| `approval-requested` | 4 | An agent action needs approval | Members with `approvals.decide` and the action's capability, except the requester when `require_other_decider` is on | Notification |
| `approval-decided` | 4 | A decider approves or rejects | The member whose agent asked | Notification |
| `generation-finished` | 4 | A generation succeeds or fails | The member who started it | Notification |
| `domain-status-changed` | 4 | A custom domain becomes active or fails. The `doxa-api` cron re-checks pending domains (every 5 minutes for 24 hours, then hourly) and verified domains (daily), so the email goes out without a manual check. | Members with `domains.write` | Notification |

Notification emails need user preferences (on by default, one switch for each category), a `List-Unsubscribe` header with an HTTPS one-click link, and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Phase 4 adds a `category` field to `EmailKind`. Transactional emails have no unsubscribe link.

## 11. Setup

### 11.1 Cloudflare (needs approval: DNS and Wrangler production config)

1. In the Cloudflare dashboard, open **Email Service** and onboard the sending subdomains `mail.doxa.so` (invites) and `notification.doxa.so` (notifications). Onboard one more subdomain for each new stream.
2. Let Cloudflare add the SPF, DKIM, and return-path records to the `doxa.so` zone.
3. Add a DMARC record for each sending subdomain with `p=none` first. Change it to `p=quarantine` after two weeks of clean reports.
4. Keep **Drop suppressed recipients** off, so that a suppressed send returns `E_RECIPIENT_SUPPRESSED`.
5. Add the binding to the `doxa-email` Wrangler file:

```jsonc
{
  "send_email": [
    { "name": "EMAIL", "allowed_sender_addresses": ["no-reply@mail.doxa.so", "no-reply@notification.doxa.so"] }
  ],
  "vars": {
    "EMAIL_PROVIDER": "cloudflare",
    "EMAIL_FROM_TRANSACTIONAL": "Doxa <no-reply@mail.doxa.so>",
    "EMAIL_FROM_NOTIFICATIONS": "Doxa <no-reply@notification.doxa.so>",
    "EMAIL_REPLY_TO": "support@doxa.so"
  }
}
```

### 11.2 Local development

- `wrangler dev` simulates the binding. It logs each email and saves it to local files. Keep `EMAIL_PROVIDER=cloudflare` locally.
- To send real email from a local run, set `"remote": true` on the binding. Send only to team addresses.
- Use `EMAIL_PROVIDER=log` in tests and scripts that run outside `wrangler dev`.
- Use the preview server (section 8.2) for design work. It needs no Worker.

## 12. Security and privacy

- `findEmailMessageProblem` refuses line breaks in the subject and in header values, and unsafe characters in display names. This stops header injection.
- `EmailAction` refuses links that are not `https:` (section 8.4).
- An invite email holds the invite link. The link works once and expires after 7 days. The email adds no new secret.
- An invite email to any address is a spam risk. Limit email invites to 20 for each team in each hour. The limit is an open question (section 15).
- Logs hold no email addresses and no props.
- The `send_email` binding allows only the stream senders (today `no-reply@mail.doxa.so` and `no-reply@notification.doxa.so`).
- Only `doxa-email` holds the binding.

## 13. Tests

- Phase 1 (done): 49 tests in `packages/email/tests/`. They cover the message rules, address parsing, the Cloudflare mapping and each error code, the registry and configuration errors, the mailer with the memory and log transports, stored props, the template registry, HTML escaping, and the link guard.
- Phase 2: outbox insert and dedupe, claim race (two consumers, one send), retry and final states for each failure kind, sweeper for stale `queued` and `sending` rows. Use `MemoryEmailTransport.failNextWith`.
- Phase 3: invite route with an email, rate limit, and no email for a link-only invite.

Run: `pnpm --filter @doxahq/email typecheck` and `pnpm --filter @doxahq/email test`.

## 14. Phases

| Phase | Content | Approval needed |
|---|---|---|
| 1 | Package `@doxahq/email`: provider layer, Cloudflare adapter, catalog, react-email templates, mailer, tests. **Done.** | None |
| 2 | Migration `0031_email`. Worker `apps/email-worker` (`doxa-email`) with the queue consumer and the `send_email` binding. `EmailOutbox`, `EmailDeliveryApi` RPC, sweeper in the `doxa-api` cron. **Done in code.** | Run the migration, create the queue, deploy the Worker |
| 3 | Team invite by email: `email` field, 20 for each team in one hour, dashboard field, `docs/current/teams.md`. **Done in code.** | Domain onboarding and DNS |
| 4 | Approval, generation and domain notifications. `category` on kinds. Preferences API and settings section. Unsubscribe page and one-click route. **Done in code.** | The Phase 2 deployment |
| 5 | Hourly suppression sync with the Cloudflare suppression API. `/admin/emails` delivery log. **Done in code.** | Set `CLOUDFLARE_ACCOUNT_ID` and the secret `CLOUDFLARE_EMAIL_API_TOKEN` |

## 15. Open questions

The implementation uses the first answer of each question. Change it if the answer is different.

1. Is `support@doxa.so` a real inbox for replies? (Used: yes, in `apps/email-worker/wrangler.json`.) Decided: invites send from `mail.doxa.so`, notifications from `notification.doxa.so`. Both are onboarded.
2. What is the limit for email invites? (Used: 20 for each team in one hour, `TEAM_INVITE_EMAILS_PER_HOUR`.)
3. Do approval request emails go to all eligible deciders, or to owners and admins only? (Used: all eligible deciders.)
4. Does Doxa want sign-in by magic link later? If yes, Better Auth's `sendMagicLink` can call the outbox with a new kind.
