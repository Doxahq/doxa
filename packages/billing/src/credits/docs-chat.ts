import type { Catalog } from "../catalog/define";
import type { Entitlements } from "../entitlements/resolve";
import { PlanLimitError } from "../errors";
import type { CreditMeter } from "./meter";

/**
 * The planned docs chat port (spec 10.9, decision D10). The chat project
 * only connects to it: `begin(siteId, requestId)` finds the billing account
 * of the site and opens the meter of `docs_chat.answer`. An answer is
 * charged; no answer and an error cost 0.
 *
 * While the action is `planned`, `begin` throws `PlanLimitError` with
 * `coming_soon`. `apps/api/src/services/docs-chat-billing.ts` wraps this.
 */

export const DOCS_CHAT_ACTION = "docs_chat.answer" as const;
export const DOCS_CHAT_SUBJECT_KIND = "chat_request";

export type DocsChatOutcome = "answered" | "no_answer" | "failed";

export interface DocsChatSession {
  accrue(usage: { callId: string; costUsd: number | string | null }): Promise<{ stopped: boolean }>;
  finish(outcome: DocsChatOutcome): Promise<{ charged: number }>;
}

export interface DocsChatBilling {
  begin(siteId: string, requestId: string): Promise<DocsChatSession>;
}

export function createDocsChatBilling(deps: {
  catalog: Catalog;
  meter: CreditMeter;
  /** The site's billing account and its entitlements (through `resolveBillingAccount`). */
  resolveSite(siteId: string): Promise<{ accountId: string; entitlements: Entitlements }>;
}): DocsChatBilling {
  return {
    async begin(siteId, requestId) {
      const action = deps.catalog.actions[DOCS_CHAT_ACTION];
      const { accountId, entitlements } = await deps.resolveSite(siteId);
      const feature = action.feature ?? "ai.docs_chat";
      if (action.status === "planned" || !entitlements.features[feature]) {
        throw new PlanLimitError({
          key: feature,
          limit: false,
          used: null,
          reason: action.status === "planned" ? "coming_soon" : (entitlements.featureReasons[feature] ?? "not_in_plan"),
        });
      }
      const subject = { kind: DOCS_CHAT_SUBJECT_KIND, id: requestId };
      const opened = await deps.meter.open({ accountId, actionKey: DOCS_CHAT_ACTION, subject });
      const metered = opened.kind === "reserved";
      return {
        async accrue(usage) {
          if (!metered) return { stopped: false };
          const result = await deps.meter.accrue({ subject, callId: usage.callId, costUsd: usage.costUsd });
          return { stopped: result.stop !== null };
        },
        async finish(outcome) {
          if (!metered) return { charged: 0 };
          const result = await deps.meter.settle({ subject, outcome });
          return { charged: result.charged };
        },
      };
    },
  };
}
