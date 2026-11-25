import type { AnalyticsGroupType, AnalyticsProperties } from "./catalog";
import type { AnalyticsGroups } from "./product-analytics";

/**
 * A record that passed the catalog. Only `ProductAnalyticsClient` makes
 * these, so a sink never sees a property that the catalog does not list.
 */
export type AnalyticsRecord =
  | {
      readonly kind: "event";
      readonly event: string;
      readonly distinctId: string;
      readonly properties: AnalyticsProperties;
      readonly groups: AnalyticsGroups;
    }
  | {
      readonly kind: "person";
      readonly distinctId: string;
      readonly properties: AnalyticsProperties;
      readonly firstProperties: AnalyticsProperties;
    }
  | {
      readonly kind: "group";
      readonly groupType: AnalyticsGroupType;
      readonly groupKey: string;
      readonly properties: AnalyticsProperties;
    }
  | {
      readonly kind: "exception";
      readonly error: unknown;
      /** Null for a request without a user, or for a person who turned analytics off. */
      readonly distinctId: string | null;
      /** The browser session of the request, or null. Null with a null `distinctId`. */
      readonly sessionId: string | null;
      readonly properties: AnalyticsProperties;
    };

/**
 * The only seam between Doxa and an analytics provider. A new provider is
 * one class that implements this interface.
 */
export interface AnalyticsSink {
  /** A stable name, such as `posthog`. */
  readonly provider: string;
  /** Queues one record. It must not wait for the network. */
  send(record: AnalyticsRecord): void;
  /** Sends what is queued. */
  flush(): Promise<void>;
  /** Sends what is queued and stops. Only the owner of the sink calls it. */
  shutdown(): Promise<void>;
}
