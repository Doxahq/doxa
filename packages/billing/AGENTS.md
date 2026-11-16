# Billing package rules

`@doxahq/billing` owns every billing rule. The design is in
`docs/billing/spec.md`. Read section 7 before you change pricing.

## How to change pricing safely

1. Change only `src/catalog/doxa.ts` for a price, an offer, a limit, a
   pay-as-you-go setting, a base fee, the markup or a cap.
2. Never change the amount of an existing price key. Add a new version, for
   example `pro_monthly_v2`. Set the old key to
   `availableForNewCustomers: false`. Customers on the old key stay on it.
3. Run `pnpm --filter @doxahq/billing test`. The catalog tests and the lock
   test must pass.
4. Update `catalog.lock.json` only for a new key, or for a change to the
   markup, a base fee or the model price table
   (`packages/agent/src/core/providers/anthropic-pricing.ts`). To write it, run
   `BILLING_WRITE_CATALOG_LOCK=1 pnpm --filter @doxahq/billing test catalog-lock`.
   The command never writes over a changed price.
5. In the pull request, say which customer charges change.
6. Run `pnpm billing:catalog:sync` against the sandbox. Paste the plan in the
   pull request.
7. Ask the user before a live sync.
8. A new feature or limit key needs an enforcement point and a test in the
   same change. Spec section 9.3 lists the enforcement points.
9. To change the founder offer after launch, add `founder_v2`. Never lower
   `maxAccounts` of a live offer below its claimed count.

## Code rules

- Feature code never imports a provider. Only this package knows the
  provider.
- `src/catalog/**` has no runtime dependency. The web app imports only
  `@doxahq/billing/catalog`.
- `@doxahq/billing/payments` is for the API Node origin only. `apps/mcp` and
  the Workers never import it.
- Logic never reads the clock. Inject a `Clock`. Tests use `FakeClock`.
- Credits are integers. USD model costs are bigint picodollars, rounded once
  at settle.
- Every credit write goes through `CreditLedger` in one `withAccountLock`
  transaction, with an idempotency key.
- A new store must pass `describeBillingStoreContract()`. A new provider
  must pass `describeBillingProviderContract()`. Both are in
  `@doxahq/billing/testing`.
- Never write a provider account ID or a provider price ID in this repo. The
  provider finds its prices by the catalog key (the lookup key).
- Keep tests deterministic and local. Tests that need Postgres or a Stripe
  sandbox are opt-in and named `*.integration.test.ts`.
