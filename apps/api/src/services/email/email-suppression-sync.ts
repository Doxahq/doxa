import { CloudflareSuppressionSource, type EmailSuppressionSource } from "@doxahq/email";
import type { DbEnv } from "@doxahq/db";
import type { Env } from "../../env";
import { EmailSuppressionsRepository } from "../../repositories/email-deliveries";
import type { EmailSuppressionStore } from "./email-delivery-store";
import { consoleEmailLog, type EmailLog } from "./email-log";

/** Enough for 20,000 entries in one run; the next run goes on from the start. */
const MAX_PAGES_PER_RUN = 20;

export interface EmailSuppressionSyncDeps {
  readonly source: EmailSuppressionSource;
  readonly suppressions: Pick<EmailSuppressionStore, "suppress">;
  readonly log: EmailLog;
}

/**
 * Copies the provider's permanent suppressions into `email_suppressions`
 * (email spec §9.1). Doxa then keeps the list after a provider swap. It only
 * adds addresses: removing one is a manual decision.
 */
export class EmailSuppressionSync {
  constructor(private readonly deps: EmailSuppressionSyncDeps) {}

  /** `null` when the provider's API is not configured. */
  static fromEnv(env: Pick<Env, "CLOUDFLARE_ACCOUNT_ID" | "CLOUDFLARE_EMAIL_API_TOKEN"> & DbEnv): EmailSuppressionSync | null {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
    const apiToken = env.CLOUDFLARE_EMAIL_API_TOKEN?.trim();
    if (!accountId || !apiToken) return null;
    return new EmailSuppressionSync({
      source: new CloudflareSuppressionSource({ accountId, apiToken }),
      suppressions: EmailSuppressionsRepository.fromEnv(env),
      log: consoleEmailLog,
    });
  }

  async run(): Promise<number> {
    let cursor: string | null = null;
    let imported = 0;
    for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
      const result = await this.deps.source.listSuppressions(cursor);
      imported += await this.deps.suppressions.suppress(
        result.entries.map((entry) => ({ ...entry, source: this.deps.source.provider })),
      );
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    this.deps.log("email_suppression_sync", { imported, provider: this.deps.source.provider });
    return imported;
  }
}

/** The 5-minute cron runs the sync in the first run of each hour. */
export function isFirstCronRunOfHour(scheduledTime: number): boolean {
  return new Date(scheduledTime).getUTCMinutes() < 5;
}
