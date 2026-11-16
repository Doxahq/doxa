# Billing provider research

Date: 2026-11-12. Question: use Autumn, another billing layer, or Stripe with
our own credit ledger? Special focus: does a tool make AI credit accounting
much easier? The design that follows from this research is in
[spec.md](spec.md).

Items marked UNVERIFIED come from one secondary source, or we did not find a
source to check them. Prices and product states change often, so check them again before a
new decision.

## Verdict

Use **Stripe for money and our own credit ledger in Postgres**, behind the
`BillingProvider` interface.

1. Autumn has the right features for AI credits (credit systems, locks,
   resets plus packs, an idempotent `track`). But it owns plan state and
   balances, its gate is a network call, and its defaults fail open.
2. The Autumn core repository returns HTTP 404 on GitHub (checked 2026-11-12,
   web and API). The last public Apache-2.0 code survives only in forks, with
   the newest commit on 2026-10-16.
3. Our credits have a fixed price per action, we already record every model
   call, and an empty balance is a hard stop, not an overage bill. We do not
   need token metering or Stripe Meters.
4. Stripe-native features do not gate in real time. Meters are asynchronous,
   billing credits apply only to metered invoices, Entitlements are on/off
   only, and token billing is a Metronome product. `@stripe/token-meter` is
   deprecated since 2026-11-06 (checked in the npm registry).
5. Use Checkout, the Customer Portal, Smart Retries and either Stripe Tax or
   Managed Payments in every option.

## Comparison

| Option | Model | Open source | Cost | Credits and packs | Real-time gate | Concurrency | Lock-in | Fit |
|---|---|---|---|---|---|---|---|---|
| Autumn hosted | Layer between the app and our Stripe account. Autumn creates the Stripe products, prices and subscriptions. | Docs say open source. Core repo is 404. | Free up to $8K/month billing volume. Pro $375/month up to $50K. Stripe Billing 0.7% on top. | Yes: credit systems, one-off top-ups, rollovers, auto top-ups, expiry | Yes, a network `check`. Edge cache in private preview. | Locks and `Idempotency-Key` | Medium. Stripe objects stay ours, but plan logic and balances live in Autumn. | Good features, wrong risk |
| Autumn self-hosted | Same, run by us | Apache-2.0 forks only | Our infrastructure: Postgres, Redis, BullMQ, SQS, ClickHouse, Trigger.dev | Same, as of the fork | Yes | Yes | A frozen fork with no upstream | No |
| **Stripe + own ledger** | Stripe for money, Postgres for credits | Our code | Stripe Billing 0.7%. Tax 0.5% per transaction, or Managed Payments +3.5%. | We build it (small) | Yes, in-process, same database | Row lock or conditional `UPDATE` | Lowest | **Yes** |
| Metronome (Stripe-owned) | Metering, rating and credit ledger. Sends invoices to Stripe. | No | Startup tier 0.8% + $0.04 per 1K events | Strong: prepaid commits, auto-recharge, custom credit units | Claims real time. No reservation primitive found (UNVERIFIED). | UNVERIFIED | High | Built for enterprise and raw tokens |
| Lago | Metering and billing | AGPL-3.0 | 0.7% after the first $100K billed | Wallets, top-ups | Not a gating engine (UNVERIFIED) | UNVERIFIED | Medium | Invoicing first |
| Flexprice | Metering and billing | AGPL-3.0 | $99/month up to $300K | Prepaid credits, wallets | Claims a real-time balance | UNVERIFIED | Medium | Maybe later |
| Polar | Merchant of record | Apache-2.0 | 5% + 50¢ on Starter, down to 3.4% + 30¢ | Meters, credit benefit | Partial | UNVERIFIED | High | Replaces Stripe |

## What each option leaves for us to build

| Concern | Autumn | Stripe only | Own ledger |
|---|---|---|---|
| Token accounting | `trackTokens` | Metronome only | Done: `generation_usage_records`, one record for each model call, in real time |
| Usage to credits | Credit cost per feature, or tokens | No | Model cost × markup + base fee, from the catalog |
| Real-time balance and gate | `check` over the network, fails open by default | No (meters are async) | In-process query in the same transaction |
| Holds for long jobs | `lock` + `finalize`, 24 h maximum | No | Reservation rows with hold, settle, release and a sweep |
| Refund on failure | Release, or a negative `track` | No | Release the hold, or a compensating entry |
| Concurrent jobs on one balance | Handled (by their docs) | No | Account row lock |
| Monthly reset and packs with expiry | Resets, `one_off` balances, expiry order | Grants are invoice credits only | Grant rows with `expires_at`, soonest expiry first |
| Ledger and audit | Ledger API | Credit balance transactions (invoice credits only) | Append-only entries with per-event detail |
| Idempotency | `Idempotency-Key` on `track` | Meter `identifier` | Unique key per action and job |
| Plans as config | `atmn` config pushed to Autumn | Products and prices with lookup keys | Typed catalog synced to Stripe lookup keys |
| Still needed in every option | Map customers to teams, the "AI paused" UI, Checkout, webhooks | Same, plus all of the above | Same |

Autumn saves the reservation and ledger mechanics and some subscription edge
cases. With fixed costs per action, no overage and one balance per account,
those mechanics are about 4 tables and one transactional service. The hard
part is the generation hold: reserve with an estimate, fix the hold when the
plan is ready, settle the real amount, release on failure, and sweep stale
holds. Spec section 10.5 covers it.

## Autumn

- **What it is:** "your source of truth for billing and entitlements between
  your application and Stripe"
  ([welcome](https://docs.useautumn.com/welcome.md)). YC S25, London, a team of
  5 ([YC](https://www.ycombinator.com/companies/autumn)). Funding figures
  disagree (UNVERIFIED).
- **Stripe ownership:** we connect our own Stripe account. Autumn creates the
  products, prices, subscriptions, meters and webhook endpoints, and says that
  it "owns the customer state"
  ([Stripe sync](https://docs.useautumn.com/documentation/concepts/stripe.md)).
  A config-as-code file exists (`autumn.config.ts` with `atmn push`,
  [CLI config](https://docs.useautumn.com/cli/config.md)), but the state lives
  in Autumn.
- **API:** `check` (can deduct with `sendEvent` and hold with `lock`,
  [check](https://docs.useautumn.com/documentation/customers/check.md)),
  `track` (negative values for refunds, `Idempotency-Key`,
  [track](https://docs.useautumn.com/api-reference/core/track.md)),
  `billing.attach`, the customer portal and a balance ledger API.
- **Credits:** boolean, metered and `credit_system` features. A credit system
  maps many features onto one balance, each with its own cost
  ([credit systems](https://docs.useautumn.com/documentation/modelling-pricing/credit-systems.md)).
  Plan balances reset, top-ups are `one_off` balances, and a debit takes the
  shortest reset first, then the soonest expiry
  ([balances](https://docs.useautumn.com/documentation/concepts/balances.md)).
- **Holds:** `check` with a `lock`, then `balances.finalize` to confirm,
  change or release. A lock lasts at most 24 h, and **a lock with no
  `expires_at` that nobody finalizes is confirmed (charged) after 24 h**
  ([balance locking](https://docs.useautumn.com/documentation/customers/balance-locking.md)).
- **Consistency risks:**
  - `track` is queued by default and answers 202 with `balance: null`. A
    synchronous debit needs `async: false`
    ([tracking](https://docs.useautumn.com/documentation/customers/tracking-usage.md)).
  - The SDKs fail open by default: on a 5xx or a timeout, `check` returns
    `allowed: true` and `track` is dropped
    ([fail-open](https://docs.useautumn.com/documentation/fail-open.md)). For
    us this means unpaid model calls during an Autumn outage, or paused AI
    features if we turn fail-open off.
  - Rate limits: 10K requests per second per customer for `check` and
    `track`, 30 per minute for `attach`
    ([rate limits](https://docs.useautumn.com/documentation/rate-limits.md)).
- **Reliability record:** a database outage on 2026-03-15 with a post-mortem,
  a move to PlanetScale in April 2026, and "Saying goodbye to multi-region" in
  June 2026 ([blog](https://useautumn.com/blog)). One user reported 11.5 s p95
  latency on 2026-07-30 (unofficial,
  [thread](https://www.answeroverflow.com/m/1532950365966700665)).
- **Open source:** `github.com/useautumn/autumn` returns 404. The org's public
  repos are SDKs and templates
  ([org](https://github.com/orgs/useautumn/repositories)). The self-hosting
  docs page is also gone. The last fork README lists SQS, ClickHouse,
  Trigger.dev, Upstash, BullMQ and Svix as dependencies. Autumn did not say why
  the repo went private (UNVERIFIED).
- **Better Auth:** a plugin in `autumn-js/better-auth` with
  `customerScope: user | organization` and a custom `identify()`
  ([docs](https://better-auth.com/docs/plugins/autumn)).

## Stripe-native

- **Meters:** asynchronous. Summaries "might not immediately reflect recently
  received meter events". 1,000 calls per second, v2 meter event streams up to
  10K events per second, deduplication by `identifier`
  ([recording usage](https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage-api)).
  We cannot gate on meters.
- **Billing credits (credit grants):** monetary credits that apply at invoice
  finalization, only to metered prices, at most 100 unused grants per customer
  ([billing credits](https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits)).
  They do not model "10,000 credits that pause features when used up".
- **Entitlements:** on/off features on products, no quantities. Stripe
  recommends a local copy
  ([entitlements](https://docs.stripe.com/billing/entitlements.md?dashboard-or-api=api)).
- **Token billing:** "in public preview and available to all users with a
  Metronome account" ([token billing](https://docs.stripe.com/billing/token-billing)).
  Stripe completed the Metronome acquisition on 2026-01-14
  ([newsroom](https://stripe.com/newsroom/news/stripe-completes-metronome-acquisition)).
  `@stripe/token-meter` 0.1.1 is deprecated: "No longer maintained; no further
  updates, including security fixes" (npm, 2026-11-06).
- **Prices:** Billing 0.7% of billing volume. Tax 0.5% per transaction.
  Managed Payments +3.5% ([pricing](https://stripe.com/pricing)).

### Managed Payments (Stripe as merchant of record)

- Handles sales tax, VAT and GST in more than 80 countries, plus fraud,
  disputes and transaction-level customer support
  ([overview](https://docs.stripe.com/payments/managed-payments)).
- Enabled per Checkout Session with `managed_payments[enabled]=true`, in
  `subscription` and `payment` mode. Needs API version `2025-03-31.basil` or
  later and an eligible tax code on each product
  ([update Checkout](https://docs.stripe.com/payments/managed-payments/update-checkout)).
- Not supported: subscriptions created outside Checkout or Payment Links,
  one-off invoices, invoice items on a customer, Connect, Elements.
- "You can only enable Managed Payments for new subscriptions purchased
  through a Managed Payments Checkout Session. Existing subscriptions aren't
  eligible." So we decide before the first customer.
- Checkout refuses some parameters with Managed Payments: `automatic_tax`,
  `tax_id_collection`, `customer_update`, `payment_method_types`,
  `invoice_creation`, `subscription_data.invoice_settings` and others.
- A Managed Payments subscription "only authorizes Managed Payments to charge
  their payment method". A charge outside Managed Payments needs its own
  consent, so packs also go through a Managed Payments Checkout.
- UNVERIFIED: plan switches through the Customer Portal on a Managed Payments
  subscription. Test this in the sandbox before decision D2.

## Other options, briefly

- **Lago:** AGPL-3.0, active. Premium features are commercial, also when
  self-hosted ([pricing](https://getlago.com/pricing)). Built for invoicing.
- **OpenMeter:** Apache-2.0. Kong bought it in September 2025, and the cloud
  product is now part of Konnect
  ([Kong](https://konghq.com/blog/news/kong-acquires-openmeter)). API-gateway
  focus.
- **Flexprice:** AGPL-3.0. $99/month plan with prepaid credits, wallets and
  entitlements ([pricing](https://flexprice.io/pricing)). No documented holds
  (UNVERIFIED).
- **Orb:** Adyen bought it, closing around 2026-07-01
  ([Banking Dive](https://www.bankingdive.com/news/adyen-buy-orb-335-million/822920/)).
  Enterprise focus.
- **m3ter:** Salesforce closed the acquisition on 2026-07-01
  ([Salesforce](https://salesforce.com/news/stories/salesforce-signs-definitive-agreement-to-acquire-m3ter/)).
- **Polar:** Apache-2.0 merchant of record with meters and a credit benefit
  ([fees](https://polar.sh/docs/merchant-of-record/fees)). It replaces Stripe as
  the merchant.
- **Paddle:** merchant of record, 5% + 50¢
  ([pricing](https://www.paddle.com/pricing)). No credit product found.
- **Lemon Squeezy:** Stripe-owned, and it sends users to Managed Payments
  ([2026 update](https://www.lemonsqueezy.com/blog/2026-update)).
- **Dodo Payments:** merchant of record with credit entitlements, meters and
  wallets ([docs](https://docs.dodopayments.com/llms.txt)). A young company.
- **Flowglad:** core repo also gone from GitHub. The YC tagline changed, which
  suggests a pivot (UNVERIFIED).
- **Schematic, Stigg:** closed-source entitlement and credit layers on Stripe.
  The same trade-off as Autumn.
- **Credyt:** wallet-based billing for AI, launched November 2025 (UNVERIFIED).
  Too new.
- **Better Auth Stripe plugin** (`@better-auth/stripe`): subscriptions,
  Checkout and the portal by `referenceId`. One active subscription per
  reference, no credits ([docs](https://better-auth.com/docs/plugins/stripe)).
  Our own provider covers the same ground, so we do not need it.

## AI usage pricing in the market

Added 2026-11-13. Question: a fixed price for each action, or a base fee plus
the metered model usage with a markup?

### Mintlify (official pages, read 2026-11-13)

- **Spring 2026: token-based credits.** "Credits previously varied with the
  tokens used by each run." Every AI feature was on one meter.
- **8 September 2026: fixed price for each action.** The blog post "Simpler,
  outcome-based AI pricing" gives the reason: "nearly every one of them gave
  the same answer: unpredictability", and "You can't budget against a black
  box." It also says "The meter counted effort instead of results."
- **Prices now:** an Assistant answer is 25 credits. An automation or
  Autopilot update is 250 credits. Narration of a page is 50 credits. An
  answer that is not found, a run that changes nothing, and a failed run cost
  0. The editor agent and the Slack agent are free on Pro and Enterprise.
- **Plans:** Pro is $450 / month yearly or $540 monthly, with 10,000 credits a
  month. Overage is $0.01 a credit, off by default, with a dollar spend limit.
  Add-ons: 15,000 for $145, 40,000 for $370, 90,000 for $800 each month.
- **Pool:** credits pool for the organization. An admin can reserve credits
  for one project. Up to 50% of unused credits roll over, to at most 1.5 times
  the monthly amount. An alert emails admins at a usage percent. An activity
  log lists each action and its credits, with CSV export.
- **Trial:** 14 days of Pro with 5,000 credits and no card. It ends at 14 days
  or when the credits run out.
- Mintlify says that 96% of teams spend the same or fewer Assistant credits
  under the new model, and that teams with automations spend about 70% less,
  because most automation runs change nothing.

Sources:
[pricing](https://www.mintlify.com/pricing),
[credits docs](https://www.mintlify.com/docs/credits),
[blog post](https://www.mintlify.com/blog/outcome-based-ai-pricing).

### Others

| Product | Model | Customer reaction | Source quality |
|---|---|---|---|
| Replit Agent | Moved from $0.25 per checkpoint to "effort-based" pricing (mid 2025). A complex task became one larger checkpoint. | Users reported surprise costs. The Register: "infuriating customers with surprise cost overruns" (2025-09-18). | News article, plus Replit docs |
| Cursor | Plans include an amount of model usage at API prices. Usage above it is billed per token. | Mixed. Sources do not agree if there is a markup (0% or 20%). | Secondary blogs only, UNVERIFIED |
| v0 (Vercel) | Credits in dollars, spent per input and output token, with a published rate for each model. | Not checked. | Secondary sources, rates differ by date, UNVERIFIED |

### What follows for Doxa

1. A pure token meter failed at Mintlify because customers could not predict
   the cost. A fixed price lost Doxa money on large runs: a Doxabot run cost
   up to $0.80 of model cost for 100 credits ($1.00).
2. Doxa keeps the metered price (base fee + model cost × markup), which the
   user asked for, and adds the parts that give predictability: an estimate
   before the run, a cap for each run, a live meter, and no charge for a
   failed run.
3. Doxabot starts by itself on every push, so nobody watches its cost. It gets
   a low cap (500 credits) and its median cost on the settings page.
4. Docs chat is paid by the site owner but started by visitors. A fixed price
   for each answer (as Mintlify) can be the better fit there. The catalog
   allows both, and the chat project chooses.

## What changes the answer

- Autumn publishes its core again under an open-source license with a
  self-host guide. Then an Autumn provider behind `BillingProvider` is worth a
  trial.
- We sell postpaid overage or enterprise commits. Then look at Metronome or
  Flexprice for rating and invoicing. The ledger stays the gate.
- We want a merchant of record other than Stripe (Paddle, Polar). Then add a
  provider. Feature code does not change.
