import type {
  AnalyticsGroupProperties,
  AnalyticsGroupType,
  ExceptionProperties,
  PersonFirstProperties,
  PersonProperties,
  ProductEventProperties,
  ServerEventName,
} from "./catalog";

/** The groups that an event belongs to, by group type: the billing account and the project. */
export type AnalyticsGroups = Readonly<Partial<Record<AnalyticsGroupType, string>>>;

export interface ProductEvent<Name extends ServerEventName> {
  readonly name: Name;
  /** The Doxa user ID. Never an email, a username or a shared value such as `anonymous`. */
  readonly distinctId: string;
  readonly properties: ProductEventProperties<Name>;
  readonly groups?: AnalyticsGroups;
}

/** One server event, typed by its name. */
export type AnyProductEvent = { [Name in ServerEventName]: ProductEvent<Name> }[ServerEventName];

export interface AnalyticsPerson {
  /** The Doxa user ID. */
  readonly distinctId: string;
  /** Set on every call, so the person shows the current email. */
  readonly properties?: PersonProperties;
  /** Set once, so a later call never changes how the person signed up. */
  readonly firstProperties?: PersonFirstProperties;
}

export interface AnalyticsGroup<Type extends AnalyticsGroupType> {
  readonly type: Type;
  /** The ID of the billing account or the project. */
  readonly key: string;
  readonly properties: AnalyticsGroupProperties<Type>;
}

export type AnyAnalyticsGroup = { [Type in AnalyticsGroupType]: AnalyticsGroup<Type> }[AnalyticsGroupType];

export interface AnalyticsExceptionContext {
  /** The Doxa user ID of the request, when there is one. */
  readonly distinctId?: string;
  /**
   * The browser's PostHog session ID (the `X-POSTHOG-SESSION-ID` header), so
   * the error links to the session replay. It is analytics data, never auth.
   */
  readonly sessionId?: string;
  readonly properties?: ExceptionProperties;
}

/**
 * Product analytics as feature code sees it. Every method checks its input
 * against the catalog and returns at once: analytics never fails, slows or
 * changes the work that it reports on.
 */
export interface ProductAnalytics {
  capture(event: AnyProductEvent): void;
  /**
   * Captures events whose facts need a read first, such as the owner of a
   * billing account or a publication count. `build` runs in the background,
   * `flush()` waits for it, and a failed read sends nothing. A client with
   * analytics off never calls `build`, so it reads nothing.
   */
  captureWhenReady(build: () => Promise<readonly AnyProductEvent[]>): void;
  /** Sets person properties. */
  identify(person: AnalyticsPerson): void;
  /** Sets the properties of a billing account or a project. */
  describeGroup(group: AnyAnalyticsGroup): void;
  /** Reports an unexpected error, such as an API 5xx answer. */
  captureException(error: unknown, context?: AnalyticsExceptionContext): void;
  /**
   * Waits until every record so far has gone to the provider. It never
   * rejects. A Worker passes it to `waitUntil`, because the Worker can stop
   * before a background send ends.
   */
  flush(): Promise<void>;
}
