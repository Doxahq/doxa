import type { Env } from "../env";
import { DocsDomainChecksRepository, type DocsDomainCheckStore, type DueDomainWindows } from "../repositories/docs-domain-checks";
import { DocsDomainLifecycleService } from "./docs-domain-lifecycle";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * How often the cron checks a custom domain. Each check is one Cloudflare API
 * call and one routing probe. A margin of one minute under each interval
 * absorbs the drift of the 5-minute cron.
 */
export const DOMAIN_CHECK_SCHEDULE = {
  /** A pending domain this young is checked on every run: it can go live soon. */
  newPendingAgeMs: 24 * HOUR_MS,
  newPendingIntervalMs: 5 * MINUTE_MS - MINUTE_MS,
  /** An older pending domain probably waits for DNS records: check it hourly. */
  oldPendingIntervalMs: HOUR_MS - MINUTE_MS,
  /** A live domain is checked daily, so a removed DNS record reports itself. */
  verifiedIntervalMs: 24 * HOUR_MS - MINUTE_MS,
  batchSize: 20,
} as const;

export function dueDomainWindows(now: Date): DueDomainWindows {
  const before = (ms: number) => new Date(now.getTime() - ms);
  return {
    now,
    newPendingCreatedAfter: before(DOMAIN_CHECK_SCHEDULE.newPendingAgeMs),
    newPendingCheckedBefore: before(DOMAIN_CHECK_SCHEDULE.newPendingIntervalMs),
    oldPendingCheckedBefore: before(DOMAIN_CHECK_SCHEDULE.oldPendingIntervalMs),
    verifiedCheckedBefore: before(DOMAIN_CHECK_SCHEDULE.verifiedIntervalMs),
    limit: DOMAIN_CHECK_SCHEDULE.batchSize,
  };
}

export interface DocsDomainStatusChecksDeps {
  readonly checks: DocsDomainCheckStore;
  readonly domains: Pick<DocsDomainLifecycleService, "refreshForProject">;
  readonly now: () => Date;
  readonly log: (event: string, data: Readonly<Record<string, string | number>>) => void;
}

/**
 * The cron side of custom domain status (email spec, domain checks). It runs
 * the same refresh as the "Check again" button, so a domain that goes live or
 * breaks sends its `domain-status-changed` email without a person looking.
 */
export class DocsDomainStatusChecks {
  constructor(private readonly deps: DocsDomainStatusChecksDeps) {}

  /** `null` where Cloudflare custom hostnames are not configured. */
  static fromEnv(env: Env): DocsDomainStatusChecks | null {
    const domains = new DocsDomainLifecycleService(env);
    if (!domains.canCheckCustomDomains) return null;
    return new DocsDomainStatusChecks({
      checks: DocsDomainChecksRepository.fromEnv(env),
      domains,
      now: () => new Date(),
      log: (event, data) => console.log(JSON.stringify({ service: "doxa-api", event, ...data })),
    });
  }

  /** One failed domain does not stop the batch; it waits for its next turn. */
  async run(): Promise<{ checked: number; failed: number }> {
    const due = await this.deps.checks.claimDue(dueDomainWindows(this.deps.now()));
    let failed = 0;
    for (const domain of due) {
      try {
        await this.deps.domains.refreshForProject({
          userId: domain.ownerUserId,
          projectId: domain.projectId,
          domainId: domain.domainId,
        });
      } catch (error) {
        failed += 1;
        this.deps.log("docs_domain_check_failed", {
          domainId: domain.domainId,
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }
    this.deps.log("docs_domain_checks", { checked: due.length, failed });
    return { checked: due.length, failed };
  }
}
