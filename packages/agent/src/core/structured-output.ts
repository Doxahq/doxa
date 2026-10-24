/**
 * Core Agent Library - Structured output
 * A JSON Schema that a JSON call asks the provider to follow. Providers that
 * support constrained decoding send it; the others keep plain JSON mode. The
 * caller still validates the result, because a refusal or a token-limit stop
 * can end the output early.
 */

export type JsonSchema = Record<string, unknown>;

export interface ResponseSchema {
  /** Stable name, used in logs and to remember a schema the provider rejected. */
  name: string;
  schema: JsonSchema;
}

/**
 * Schemas that a provider refused, by provider and schema name. A refused
 * schema is not sent again while this process runs, so each later call
 * goes straight to plain JSON mode.
 */
const rejectedSchemas = new Set<string>();

function rejectionKey(providerName: string, schema: ResponseSchema): string {
  return `${providerName}:${schema.name}`;
}

export function isResponseSchemaRejected(
  providerName: string,
  schema: ResponseSchema,
): boolean {
  return rejectedSchemas.has(rejectionKey(providerName, schema));
}

export function rememberRejectedResponseSchema(
  providerName: string,
  schema: ResponseSchema,
  error: unknown,
): void {
  rejectedSchemas.add(rejectionKey(providerName, schema));
  console.warn(JSON.stringify({
    service: "doxa-agent",
    eventType: "response_schema_rejected",
    provider: providerName,
    schema: schema.name,
    error: error instanceof Error ? error.message : String(error),
  }));
}

/** Test helper: forgets every rejected schema. */
export function resetRejectedResponseSchemas(): void {
  rejectedSchemas.clear();
}
