import type { z } from "zod";
import type { ProductEventSource } from "./define-event";
import { ANALYTICS_GROUPS, EXCEPTION_PROPERTIES, PERSON_FIRST_PROPERTIES, PERSON_PROPERTIES } from "./entities";
import { PRODUCT_EVENTS } from "./events";

export { PRODUCT_EVENTS } from "./events";
export { ANALYTICS_GROUPS, EXCEPTION_PROPERTIES, PERSON_FIRST_PROPERTIES, PERSON_PROPERTIES } from "./entities";
export type { ProductEventDefinition, ProductEventSource } from "./define-event";

export type ProductEventName = keyof typeof PRODUCT_EVENTS;

type EventNamesFrom<Source extends ProductEventSource> = {
  [Name in ProductEventName]: (typeof PRODUCT_EVENTS)[Name]["source"] extends Source ? Name : never;
}[ProductEventName];

/** Events that only the API sends. */
export type ServerEventName = EventNamesFrom<"server">;
/** Events that only the browser sends. */
export type BrowserEventName = EventNamesFrom<"browser">;

export type ProductEventProperties<Name extends ProductEventName> = z.input<
  (typeof PRODUCT_EVENTS)[Name]["properties"]
>;

export type AnalyticsGroupType = keyof typeof ANALYTICS_GROUPS;
export type AnalyticsGroupProperties<Type extends AnalyticsGroupType> = z.input<(typeof ANALYTICS_GROUPS)[Type]>;
export type PersonProperties = z.input<typeof PERSON_PROPERTIES>;
export type PersonFirstProperties = z.input<typeof PERSON_FIRST_PROPERTIES>;
export type ExceptionProperties = z.input<typeof EXCEPTION_PROPERTIES>;

/** A property value after parsing. Nested objects never reach a provider. */
export type AnalyticsPropertyValue = string | number | boolean;
export type AnalyticsProperties = Readonly<Record<string, AnalyticsPropertyValue>>;

/**
 * The result of parsing properties against the catalog. A failure names the
 * paths that failed, never the values, because a value can be the content
 * that the catalog keeps out.
 */
export type PropertiesParseResult =
  | { readonly ok: true; readonly properties: AnalyticsProperties }
  | { readonly ok: false; readonly paths: readonly string[] };

export function isProductEventName(value: string): value is ProductEventName {
  return Object.hasOwn(PRODUCT_EVENTS, value);
}

export function isAnalyticsGroupType(value: string): value is AnalyticsGroupType {
  return Object.hasOwn(ANALYTICS_GROUPS, value);
}

/** Keeps only the catalog's properties of the event. */
export function parseProductEventProperties<Name extends ProductEventName>(
  name: Name,
  properties: ProductEventProperties<Name>,
): PropertiesParseResult {
  if (!isProductEventName(name)) return { ok: false, paths: ["(event)"] };
  return parseProperties(PRODUCT_EVENTS[name].properties, properties);
}

export function parseGroupProperties<Type extends AnalyticsGroupType>(
  type: Type,
  properties: AnalyticsGroupProperties<Type>,
): PropertiesParseResult {
  if (!isAnalyticsGroupType(type)) return { ok: false, paths: ["(group)"] };
  return parseProperties(ANALYTICS_GROUPS[type], properties);
}

/** Parses against one schema of this catalog and drops the keys that it does not list. */
export function parseProperties(schema: z.ZodType, input: unknown): PropertiesParseResult {
  const result = schema.safeParse(input);
  if (!result.success) {
    return { ok: false, paths: result.error.issues.map((issue) => issue.path.join(".") || "(root)") };
  }
  return { ok: true, properties: withoutUndefined(result.data) };
}

function withoutUndefined(data: unknown): AnalyticsProperties {
  const properties: Record<string, AnalyticsPropertyValue> = {};
  if (typeof data !== "object" || data === null) return properties;
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      properties[key] = value;
    }
  }
  return properties;
}
