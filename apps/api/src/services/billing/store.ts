import { createPostgresBillingStore, type BillingStore } from "@doxahq/billing";
import { createDb, type DbEnv } from "@doxahq/db";

/**
 * The one place that builds the Postgres billing store (billing spec 6.1).
 * Building it opens no connection: the request's database scope does.
 */
export function createBillingStore(env: DbEnv): BillingStore {
  return createPostgresBillingStore(createDb(env));
}
