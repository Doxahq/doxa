/**
 * Provider-neutral product analytics: the event catalog, the client that
 * checks every record against it, and the sink seam. It has no SDK: the
 * PostHog sink is `@doxahq/analytics/posthog`, and the browser helpers are
 * `@doxahq/analytics/browser`.
 */
export {
  ANALYTICS_GROUPS,
  EXCEPTION_PROPERTIES,
  PERSON_FIRST_PROPERTIES,
  PERSON_PROPERTIES,
  PRODUCT_EVENTS,
  isProductEventName,
  parseProductEventProperties,
  type AnalyticsGroupProperties,
  type AnalyticsGroupType,
  type AnalyticsProperties,
  type AnalyticsPropertyValue,
  type BrowserEventName,
  type ExceptionProperties,
  type PersonFirstProperties,
  type PersonProperties,
  type ProductEventDefinition,
  type ProductEventName,
  type ProductEventProperties,
  type ProductEventSource,
  type PropertiesParseResult,
  type ServerEventName,
} from "./catalog";
export {
  POSTHOG_US_HOST,
  SERVER_POSTHOG_SETTING_NAMES,
  postHogSettingsFromEnv,
  readPostHogSettings,
  type AnalyticsEnv,
  type PostHogSettingNames,
  type PostHogSettings,
  type PostHogSettingsResult,
} from "./config";
export { NOOP_PRODUCT_ANALYTICS } from "./noop-product-analytics";
export type {
  AnalyticsExceptionContext,
  AnalyticsGroup,
  AnalyticsGroups,
  AnalyticsPerson,
  AnyAnalyticsGroup,
  AnyProductEvent,
  ProductAnalytics,
  ProductEvent,
} from "./product-analytics";
export {
  ProductAnalyticsClient,
  logAnalyticsDrop,
  type AnalyticsDrop,
  type AnalyticsDropReason,
  type OptOutCheck,
  type ProductAnalyticsClientOptions,
} from "./product-analytics-client";
export type { AnalyticsRecord, AnalyticsSink } from "./sink";
