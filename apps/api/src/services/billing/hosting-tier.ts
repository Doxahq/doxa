import type { DocsDomainResolution } from "@doxahq/contracts";
import { createDb, schema, type DbEnv } from "@doxahq/db";
import { and, eq, isNull } from "drizzle-orm";
import type { Env } from "../../env";
import { enqueueDocsCacheInvalidation } from "../../repositories/docs-cache-invalidations";
import { billingConfigFor, type BillingConfigEnv } from "./config";
import { billingCoreFromEnv, type BillingCore } from "./core";

export type HostingTier = NonNullable<DocsDomainResolution["hostingTier"]>;

/**
 * Billing spec 9.4: the host resolution carries the hosting tier of the
 * site's plan. The dispatcher cannot read billing tables, so the API adds
 * the tier to every production resolution it computes (the resolver Worker,
 * the hostname map, the internal RPC), only with `BILLING_ENFORCEMENT=on`.
 *
 * - `off`: the resolution keeps its old shape; the dispatcher keeps its
 *   operator list. No billing read.
 * - `shadow`: the isolate never changes. The API reads the tier and logs
 *   `billing.hosting_tier_shadow` (what `on` would send); the resolution
 *   keeps its old shape.
 * - `on`: the resolution carries `hostingTier`, and the dispatcher follows it.
 *
 * A billing error keeps the old shape too: a docs request must never fail
 * because of billing.
 */
export async function withHostingTier<T extends DocsDomainResolution>(
  env: BillingConfigEnv & DbEnv,
  resolution: T,
  coreFor: () => BillingCore = () => billingCoreFromEnv(env as Env),
  log: (line: Readonly<Record<string, string | null>>) => void = (line) => console.log(JSON.stringify({ service: "doxa-api", ...line })),
): Promise<T> {
  const enforcement = billingConfigFor(env).enforcement;
  if (enforcement === "off") return resolution;
  if (resolution.renderTarget !== undefined && resolution.renderTarget !== "production") return resolution;
  try {
    const view = await coreFor().entitlements.forProject(resolution.projectId);
    const hostingTier = view.entitlements.hosting;
    if (enforcement === "shadow") {
      log({ event: "billing.hosting_tier_shadow", projectId: resolution.projectId, siteId: resolution.siteId ?? null, hostingTier, plan: view.entitlements.plan });
      return resolution;
    }
    return { ...resolution, hostingTier };
  } catch (cause) {
    const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error";
    console.warn(JSON.stringify({ service: "doxa-api", event: "billing.hosting_tier_failed", projectId: resolution.projectId, message }));
    return resolution;
  }
}

/**
 * Billing spec 9.4: a plan change (`billing.plan_changed`) moves the
 * account's sites. One cache invalidation for each site rewrites its
 * hostname map entries with the new tier within one scheduler run; the
 * hostname map reconcile corrects a missed write. Only with enforcement
 * `on`: in `shadow` the resolution has no tier, so there is nothing to move.
 */
export async function queueHostingTierRefresh(env: Env, accountId: string, coreFor: () => BillingCore = () => billingCoreFromEnv(env)): Promise<number> {
  if (billingConfigFor(env).enforcement !== "on") return 0;
  const account = await coreFor().store.getAccount(accountId);
  if (!account?.ownerId) return 0;
  const db = createDb(env);
  const owner =
    account.ownerKind === "team"
      ? eq(schema.projects.teamId, account.ownerId)
      : and(eq(schema.projects.userId, account.ownerId), isNull(schema.projects.teamId));
  const sites = await db
    .select({ siteId: schema.docsSites.id })
    .from(schema.docsSites)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.docsSites.projectId))
    .where(owner);
  if (sites.length === 0) return 0;
  await db.transaction(async (tx) => {
    for (const site of sites) await enqueueDocsCacheInvalidation(tx, { siteId: site.siteId });
  });
  return sites.length;
}
