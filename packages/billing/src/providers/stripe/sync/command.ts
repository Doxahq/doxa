import type { Catalog } from "../../../catalog/define";
import { DOXA_CATALOG } from "../../../catalog/doxa";
import { createStripeClient, type StripeClientOptions } from "../client";
import { applyStripeCatalogSync, formatCatalogSyncPlan, planStripeCatalogSync } from "./catalog-sync";

/** What the sync command reads and writes. The script passes `process.*`; tests pass fakes. */
export interface CatalogSyncCommandIo {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly print: (line: string) => void;
  /** Tests only. */
  readonly httpClient?: StripeClientOptions["httpClient"];
  readonly catalog?: Catalog;
}

const USAGE = [
  "Usage: pnpm --filter @doxahq/billing catalog:sync [--apply] [--live]",
  "",
  "Plans the Stripe catalog sync from src/catalog/doxa.ts (a dry run by default).",
  "  --apply   make the changes (idempotent; the plan is empty afterwards)",
  "  --live    required for a live key (sk_live_ / rk_live_). Ask the user first.",
  "",
  "Reads STRIPE_SECRET_KEY (a sandbox or restricted key). Never pass a key on the command line.",
];

/**
 * `pnpm billing:catalog:sync` (spec 7.3). Prints the plan; `--apply` makes the
 * changes. A live key needs `--live`, and the command prints the account name
 * before it does anything. Returns the exit code.
 */
export async function runCatalogSyncCommand(io: CatalogSyncCommandIo): Promise<number> {
  const args = new Set(io.argv);
  if (args.has("--help") || args.has("-h")) {
    USAGE.forEach((line) => io.print(line));
    return 0;
  }
  const unknown = [...args].filter((arg) => arg !== "--apply" && arg !== "--live");
  if (unknown.length > 0) {
    io.print(`Unknown argument: ${unknown.join(" ")}`);
    USAGE.forEach((line) => io.print(line));
    return 2;
  }
  const key = io.env.STRIPE_SECRET_KEY?.trim();
  if (!key || !/^(sk|rk)_(test|live)_/.test(key)) {
    io.print("Set STRIPE_SECRET_KEY to a Stripe secret or restricted key (sandbox first).");
    return 2;
  }
  const live = /^(sk|rk)_live_/.test(key);
  if (live && !args.has("--live")) {
    io.print("STRIPE_SECRET_KEY is a live key. Run against the sandbox first; for a live sync add --live (ask the user first).");
    return 2;
  }
  if (!live && args.has("--live")) {
    io.print("--live was given but STRIPE_SECRET_KEY is a test key.");
    return 2;
  }

  const stripe = createStripeClient({ secretKey: key, ...(io.httpClient ? { httpClient: io.httpClient } : {}) });
  const catalog = io.catalog ?? DOXA_CATALOG;
  let account = "unknown (the key cannot read the account)";
  try {
    const current = await stripe.accounts.retrieveCurrent();
    account = current.settings?.dashboard?.display_name ?? current.business_profile?.name ?? current.id;
  } catch {
    // A restricted key without account read permission: keep "unknown".
  }
  io.print(`Stripe account: ${account} (${live ? "LIVE" : "sandbox/test"})`);

  try {
    const plan = await planStripeCatalogSync(stripe, catalog);
    io.print(args.has("--apply") ? "Plan:" : "Plan (dry run, nothing changed):");
    formatCatalogSyncPlan(plan).forEach((line) => io.print(`  ${line}`));
    if (!args.has("--apply") || plan.actions.length === 0) return 0;
    const result = await applyStripeCatalogSync(stripe, catalog, plan);
    io.print(`Applied ${result.applied} change(s).`);
    const after = await planStripeCatalogSync(stripe, catalog);
    if (after.actions.length > 0) {
      io.print("The plan is not empty after the apply:");
      after.actions.forEach((action) => io.print(`  ${action.description}`));
      return 1;
    }
    io.print("The plan is empty.");
    return 0;
  } catch (error) {
    io.print(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
