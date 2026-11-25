import {
  EXCEPTION_PROPERTIES,
  PERSON_FIRST_PROPERTIES,
  PERSON_PROPERTIES,
  isAnalyticsGroupType,
  parseGroupProperties,
  parseProductEventProperties,
  parseProperties,
  type AnalyticsProperties,
} from "./catalog";
import { opaqueId } from "./catalog/property-schemas";
import type {
  AnalyticsExceptionContext,
  AnalyticsGroups,
  AnalyticsPerson,
  AnyAnalyticsGroup,
  AnyProductEvent,
  ProductAnalytics,
} from "./product-analytics";
import type { AnalyticsRecord, AnalyticsSink } from "./sink";

/** True when the person turned product analytics off. */
export type OptOutCheck = (distinctId: string) => Promise<boolean>;

export type AnalyticsDropReason =
  /** The record does not match the catalog. A bug in the caller. */
  | "invalid"
  /** The person turned product analytics off. Expected, so the default log skips it. */
  | "opted_out"
  /** The opt-out check failed, so the record is dropped to be safe. */
  | "opt_out_check_failed"
  /** The read of a `captureWhenReady` event failed. */
  | "read_failed"
  /** The provider threw. */
  | "sink_failed";

/** What was dropped and why. It never holds a property value. */
export interface AnalyticsDrop {
  readonly reason: AnalyticsDropReason;
  readonly record: AnalyticsRecord["kind"] | "flush";
  /** The event name or the group type. */
  readonly name?: string;
  /** For `invalid`: the property paths that failed. */
  readonly paths?: readonly string[];
}

export interface ProductAnalyticsClientOptions {
  readonly sink: AnalyticsSink;
  /**
   * Without it, every person counts as opted in. With it, events and person
   * properties of an opted-out person are dropped, and their errors are sent
   * without their ID.
   */
  readonly isOptedOut?: OptOutCheck;
  /** Default: `logAnalyticsDrop`. */
  readonly onDrop?: (drop: AnalyticsDrop) => void;
}

/**
 * The catalog gate in front of a sink. It parses every record against the
 * catalog, applies the person's opt-out, and never throws or waits: the
 * opt-out check runs in the background, and `flush` waits for it.
 */
export class ProductAnalyticsClient implements ProductAnalytics {
  readonly #sink: AnalyticsSink;
  readonly #isOptedOut: OptOutCheck | undefined;
  readonly #onDrop: (drop: AnalyticsDrop) => void;
  readonly #pending = new Set<Promise<void>>();

  constructor(options: ProductAnalyticsClientOptions) {
    this.#sink = options.sink;
    this.#isOptedOut = options.isOptedOut;
    this.#onDrop = options.onDrop ?? logAnalyticsDrop;
  }

  capture(event: AnyProductEvent): void {
    const id = checkId(event.distinctId, "distinctId");
    const properties = parseProductEventProperties(event.name, event.properties);
    const groups = parseGroups(event.groups);
    if (!id.ok || !properties.ok || !groups.ok) {
      this.#drop({ reason: "invalid", record: "event", name: event.name, paths: failedPaths(id, properties, groups) });
      return;
    }
    this.#afterOptOutCheck(event.distinctId, (optedOut) => {
      if (optedOut !== false) {
        this.#drop({ reason: optedOut ? "opted_out" : "opt_out_check_failed", record: "event", name: event.name });
        return;
      }
      this.#send({
        kind: "event",
        event: event.name,
        distinctId: event.distinctId,
        properties: properties.properties,
        groups: groups.groups,
      });
    });
  }

  captureWhenReady(build: () => Promise<readonly AnyProductEvent[]>): void {
    this.#track(
      Promise.resolve()
        .then(build)
        .then(
          (events) => {
            for (const event of events) this.capture(event);
          },
          () => this.#drop({ reason: "read_failed", record: "event" }),
        ),
    );
  }

  identify(person: AnalyticsPerson): void {
    const id = checkId(person.distinctId, "distinctId");
    const properties = parseProperties(PERSON_PROPERTIES, person.properties ?? {});
    const firstProperties = parseProperties(PERSON_FIRST_PROPERTIES, person.firstProperties ?? {});
    if (!id.ok || !properties.ok || !firstProperties.ok) {
      this.#drop({ reason: "invalid", record: "person", paths: failedPaths(id, properties, firstProperties) });
      return;
    }
    this.#afterOptOutCheck(person.distinctId, (optedOut) => {
      if (optedOut !== false) {
        this.#drop({ reason: optedOut ? "opted_out" : "opt_out_check_failed", record: "person" });
        return;
      }
      this.#send({
        kind: "person",
        distinctId: person.distinctId,
        properties: properties.properties,
        firstProperties: firstProperties.properties,
      });
    });
  }

  describeGroup(group: AnyAnalyticsGroup): void {
    const key = checkId(group.key, "key");
    const properties = parseGroupProperties(group.type, group.properties);
    if (!key.ok || !properties.ok) {
      this.#drop({ reason: "invalid", record: "group", name: group.type, paths: failedPaths(key, properties) });
      return;
    }
    this.#send({ kind: "group", groupType: group.type, groupKey: group.key, properties: properties.properties });
  }

  captureException(error: unknown, context: AnalyticsExceptionContext = {}): void {
    const parsed = parseProperties(EXCEPTION_PROPERTIES, context.properties ?? {});
    // An error report is still useful without its context, so a bad property
    // costs the context, never the report.
    const properties: AnalyticsProperties = parsed.ok ? parsed.properties : {};
    if (!parsed.ok) this.#drop({ reason: "invalid", record: "exception", paths: parsed.paths });
    const { distinctId } = context;
    if (distinctId === undefined || !checkId(distinctId, "distinctId").ok) {
      this.#send({ kind: "exception", error, distinctId: null, sessionId: null, properties });
      return;
    }
    const sessionId = validIdOrNull(context.sessionId);
    // An opted-out person's error is still reported, without their ID or their session.
    this.#afterOptOutCheck(distinctId, (optedOut) => {
      const known = optedOut === false;
      this.#send({
        kind: "exception",
        error,
        distinctId: known ? distinctId : null,
        sessionId: known ? sessionId : null,
        properties,
      });
    });
  }

  async flush(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.allSettled([...this.#pending]);
    }
    try {
      await this.#sink.flush();
    } catch {
      this.#drop({ reason: "sink_failed", record: "flush" });
    }
  }

  /** Calls `decide` with the person's opt-out: true, false, or null when the check failed. */
  #afterOptOutCheck(distinctId: string, decide: (optedOut: boolean | null) => void): void {
    const check = this.#isOptedOut;
    if (!check) {
      decide(false);
      return;
    }
    // `then` first, so a check that throws before it returns a promise is a failed check too.
    this.#track(
      Promise.resolve()
        .then(() => check(distinctId))
        .then(
          (optedOut) => decide(optedOut),
          () => decide(null),
        ),
    );
  }

  /** Background work that `flush()` waits for. The task must not reject. */
  #track(task: Promise<void>): void {
    this.#pending.add(task);
    void task.finally(() => this.#pending.delete(task));
  }

  #send(record: AnalyticsRecord): void {
    try {
      this.#sink.send(record);
    } catch {
      const name = record.kind === "event" ? record.event : record.kind === "group" ? record.groupType : undefined;
      this.#drop({ reason: "sink_failed", record: record.kind, ...(name ? { name } : {}) });
    }
  }

  #drop(drop: AnalyticsDrop): void {
    try {
      this.#onDrop(drop);
    } catch {
      // A broken reporter must not break the caller either.
    }
  }
}

/** One structured warning for each dropped record, except the expected opt-outs. */
export function logAnalyticsDrop(drop: AnalyticsDrop): void {
  if (drop.reason === "opted_out") return;
  console.warn(JSON.stringify({ service: "analytics", event: "analytics.dropped", ...drop }));
}

/** A check that failed names its paths, never its values. */
type Check<Value extends object = object> =
  | ({ readonly ok: true } & Value)
  | { readonly ok: false; readonly paths: readonly string[] };

function failedPaths(...checks: readonly Check[]): string[] {
  return checks.flatMap((check) => (check.ok ? [] : check.paths));
}

/** IDs are opaque Doxa IDs, so an email or a free-text value cannot pass as one. */
function checkId(value: string, path: string): Check {
  return opaqueId.safeParse(value).success ? { ok: true } : { ok: false, paths: [path] };
}

function validIdOrNull(value: string | undefined): string | null {
  return value !== undefined && opaqueId.safeParse(value).success ? value : null;
}

function parseGroups(groups: AnalyticsGroups | undefined): Check<{ readonly groups: AnalyticsGroups }> {
  const parsed: Partial<Record<keyof AnalyticsGroups, string>> = {};
  const paths: string[] = [];
  for (const [type, key] of Object.entries(groups ?? {})) {
    if (key === undefined) continue;
    if (isAnalyticsGroupType(type) && checkId(key, type).ok) parsed[type] = key;
    else paths.push(`groups.${type}`);
  }
  return paths.length > 0 ? { ok: false, paths } : { ok: true, groups: parsed };
}
