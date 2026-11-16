import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createDb, createSharedPgPoolProvider, usePgPoolProvider, type DoxaDb, type PgPoolProvider, type SharedPgPoolProvider } from "@doxahq/db";
import { sql } from "@doxahq/db/orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PICO_PER_USD } from "../../src/credits/usd";
import { createPostgresBillingStore } from "../../src/store/postgres";
import type { BillingStore } from "../../src/store/store";
import { StoreConflictError } from "../../src/store/store";
import { TEST_NOW, describeBillingStoreContract, subscriptionFixture } from "../../src/testing";

/**
 * The Postgres store on a real Postgres (spec 20.2): the store contract
 * suite (the ledger, the 50-reservation, settle-or-release, quota, founder,
 * accrual-stream and pay-as-you-go races) and the row mapping.
 *
 * Opt-in: set BILLING_TEST_DATABASE_URL to a server where the user may
 * create databases. The suite creates a fresh database
 * `doxa_billing_test_<random>`, applies every migration to it, runs, and
 * drops it. It never touches the database of the URL itself.
 */
const adminUrl = process.env.BILLING_TEST_DATABASE_URL;

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations/", import.meta.url));
const BILLING_TABLES = [
  "credit_accruals",
  "credit_ledger_entries",
  "payg_usage_reports",
  "payg_invoices",
  "credit_reservations",
  "credit_grants",
  "billing_offer_slots",
  "billing_offers",
  "billing_overrides",
  "billing_subscriptions",
  "billing_usage_counters",
  "billing_provider_events",
  "billing_sync_state",
  "billing_accounts",
];

/** The foreign keys from billing rows to users, teams and projects. The fixtures use free-form owner IDs. */
const OWNER_FOREIGN_KEYS = [
  ["billing_accounts", "billing_accounts_owner_user_id_user_id_fk"],
  ["billing_accounts", "billing_accounts_owner_team_id_teams_id_fk"],
  ["credit_reservations", "credit_reservations_project_id_projects_id_fk"],
] as const;

function migrationStatements(): string[] {
  const journal = JSON.parse(readFileSync(`${MIGRATIONS_DIR}meta/_journal.json`, "utf8")) as { entries: { tag: string }[] };
  return journal.entries.flatMap((entry) =>
    readFileSync(`${MIGRATIONS_DIR}${entry.tag}.sql`, "utf8")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean),
  );
}

describe.skipIf(!adminUrl)("postgres billing store", () => {
  const databaseName = `doxa_billing_test_${randomBytes(6).toString("hex")}`;
  let admin: DoxaDb;
  let db: DoxaDb;
  let pools: SharedPgPoolProvider;
  let previousPools: PgPoolProvider;

  beforeAll(async () => {
    pools = createSharedPgPoolProvider({ max: 40 });
    previousPools = usePgPoolProvider(pools);
    admin = createDb({ DATABASE_URL: adminUrl });
    await admin.execute(sql.raw(`CREATE DATABASE "${databaseName}"`));
    const url = new URL(adminUrl ?? "");
    url.pathname = `/${databaseName}`;
    db = createDb({ DATABASE_URL: url.toString() });
    for (const statement of migrationStatements()) await db.execute(sql.raw(statement));
    for (const [table, constraint] of OWNER_FOREIGN_KEYS) {
      await db.execute(sql.raw(`ALTER TABLE "${table}" DROP CONSTRAINT "${constraint}"`));
    }
  }, 120_000);

  afterAll(async () => {
    if (!pools) return;
    await pools.close();
    usePgPoolProvider(previousPools);
    // A new pool for the drop, after every connection to the test database closed.
    const dropper = createDb({ DATABASE_URL: adminUrl });
    await dropper.execute(sql.raw(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`));
    await (dropper.$client as { end(): Promise<void> }).end();
  }, 60_000);

  const emptyStore = async (): Promise<BillingStore> => {
    await db.execute(sql.raw(`TRUNCATE ${BILLING_TABLES.map((table) => `"${table}"`).join(", ")} RESTART IDENTITY CASCADE`));
    return createPostgresBillingStore(db);
  };

  describeBillingStoreContract("postgres", emptyStore);

  describe("row mapping", () => {
    const account = (store: BillingStore, ownerId = "mapping") =>
      store.ensureAccount({ ownerKind: "user", ownerId, planKey: "free", paygEnabled: false, paygMonthlyLimitCents: 5_000, now: TEST_NOW });

    it("maps the owner, a missing provider, caps and the state version", async () => {
      const store = await emptyStore();
      const created = await account(store);
      expect(created).toMatchObject({ ownerKind: "user", ownerId: "mapping", provider: null, stateVersion: 1, actionCaps: {}, paygMonthlyLimitCents: 5_000 });
      const updated = await store.withAccountLock(created.id, TEST_NOW, (tx) =>
        tx.updateAccount({ actionCaps: { "generation.run": 900 }, provider: "memory", providerCustomerId: "cus_1", aiPausedReason: "dispute" }),
      );
      expect(updated).toMatchObject({ stateVersion: 2, provider: "memory", providerCustomerId: "cus_1", aiPausedReason: "dispute", actionCaps: { "generation.run": 900 } });
      expect((await store.findAccountByProviderCustomer("memory", "cus_1"))?.id).toBe(created.id);
      expect(await store.getAccount("acct_not_a_uuid")).toBeNull();
    });

    it("round-trips a subscription with pastDueSince", async () => {
      const store = await emptyStore();
      const { id } = await account(store);
      const record = subscriptionFixture({ accountId: id, status: "past_due", pastDueSince: TEST_NOW, planKey: null });
      await store.withAccountLock(id, TEST_NOW, (tx) => tx.upsertSubscription(record));
      await store.withAccountLock(id, TEST_NOW, (tx) => tx.upsertSubscription({ ...record, cancelAtPeriodEnd: true }));
      expect(await store.getSubscription(id)).toEqual({ ...record, cancelAtPeriodEnd: true });
      expect(await store.listAccountIdsBySubscriptionStatus(["past_due"])).toEqual([id]);
    });

    it("keeps exact picodollar costs and records an unpriced accrual as unknown", async () => {
      const store = await emptyStore();
      const { id } = await account(store);
      const huge = 123_456_789n * PICO_PER_USD + 1n;
      const reservation = await store.withAccountLock(id, TEST_NOW, (tx) =>
        tx.insertReservation({
          actionKey: "generation.run",
          subjectKind: "job",
          subjectId: "exact",
          amount: 10,
          baseCredits: 5,
          capCredits: 100,
          consumedCostPico: huge,
          markupHundredths: 300,
          unitPriceCents: 1,
          inFlightMarginCredits: 20,
          stopReason: null,
          status: "held",
          idempotencyKey: "job:exact:reserve",
          expiresAt: new Date(TEST_NOW.getTime() + 60_000),
          settledAmount: null,
        }),
      );
      expect(reservation).toMatchObject({ consumedCostPico: huge, markupHundredths: 300, unitPriceCents: 1, inFlightMarginCredits: 20 });
      const outcomes = await store.withReservationLock(reservation.id, TEST_NOW, async (tx) => [
        await tx.insertAccrual({ callId: "call-1", costPico: null }),
        await tx.insertAccrual({ callId: "call-1", costPico: 5n }),
        await tx.insertAccrual({ callId: "call-2", costPico: 7n }),
        await tx.listAccruals(),
      ]);
      expect(outcomes.slice(0, 3)).toEqual(["inserted", "duplicate", "inserted"]);
      expect((outcomes[3] as { callId: string; costPico: bigint | null }[]).map((row) => [row.callId, row.costPico])).toEqual([
        ["call-1", null],
        ["call-2", 7n],
      ]);
    });

    it("pages ledger entries newest first and rejects a repeated idempotency key", async () => {
      const store = await emptyStore();
      const { id } = await account(store);
      const entry = (key: string, credits: number) => ({
        kind: "adjust" as const,
        credits,
        grantId: null,
        reservationId: null,
        actionKey: null,
        subjectKind: null,
        subjectId: null,
        idempotencyKey: key,
        metadata: { note: key },
      });
      await store.withAccountLock(id, TEST_NOW, (tx) => tx.insertEntries([entry("K#0", 1), entry("K#1", 2), entry("K#2", 3)]));
      const first = await store.listLedgerEntries(id, { limit: 2 });
      expect(first.items.map((row) => row.idempotencyKey)).toEqual(["K#2", "K#1"]);
      const second = await store.listLedgerEntries(id, { limit: 2, cursor: first.nextCursor });
      expect(second.items.map((row) => row.idempotencyKey)).toEqual(["K#0"]);
      expect(second.nextCursor).toBeNull();
      await expect(store.withAccountLock(id, TEST_NOW, (tx) => tx.insertEntries([entry("K#3", 1), entry("K#0", 1)]))).rejects.toBeInstanceOf(StoreConflictError);
      expect((await store.listLedgerEntries(id, { limit: 10 })).items).toHaveLength(3);
    });

    it("claims provider events as new, duplicate and retry, and keeps a sync cursor", async () => {
      const store = await emptyStore();
      const claim = (now: Date) => store.claimProviderEvent({ provider: "memory", eventId: "evt_1", type: "x", now, staleBefore: new Date(now.getTime() - 60_000) });
      expect(await claim(TEST_NOW)).toBe("new");
      expect(await claim(TEST_NOW)).toBe("duplicate");
      expect(await claim(new Date(TEST_NOW.getTime() + 120_000))).toBe("retry");
      await store.completeProviderEvent({ provider: "memory", eventId: "evt_1", status: "failed", error: "boom", now: TEST_NOW });
      expect(await claim(TEST_NOW)).toBe("retry");
      await store.completeProviderEvent({ provider: "memory", eventId: "evt_1", status: "processed", error: null, now: TEST_NOW });
      expect(await claim(new Date(TEST_NOW.getTime() + 600_000))).toBe("duplicate");
      expect(await store.getSyncCursor("memory")).toBeNull();
      await store.setSyncCursor("memory", "evt_9", TEST_NOW);
      await store.setSyncCursor("memory", "evt_10", TEST_NOW);
      expect(await store.getSyncCursor("memory")).toBe("evt_10");
    });
  });
});
