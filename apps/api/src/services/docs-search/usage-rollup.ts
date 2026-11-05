import {
  DOCS_SEARCH_USAGE_OUTCOMES,
  docsSearchProviderSchema,
} from "@doxahq/contracts/docs-search";
import { z } from "zod";

export const DOCS_SEARCH_USAGE_DATASET = "doxa_search_usage";

export interface DocsSearchUsageRow {
  day: string;
  siteId: string;
  provider: string;
  outcome: string;
  events: number;
  responseBytes: number;
  elapsedMsTotal: number;
}

const answerSchema = z.object({
  data: z.array(
    z.object({
      day: z.string(),
      site_id: z.uuid(),
      provider: docsSearchProviderSchema,
      outcome: z.enum(DOCS_SEARCH_USAGE_OUTCOMES),
      events: z.coerce.number(),
      response_bytes: z.coerce.number(),
      elapsed_ms_total: z.coerce.number(),
    }),
  ),
});

/**
 * The query takes only a date made here, so it has no outside input. Analytics
 * Engine samples under high load, so each sum uses `_sample_interval`.
 */
export function createUsageQuery(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Invalid usage day.");
  return `SELECT
    toDate(timestamp) AS day,
    blob1 AS site_id,
    blob2 AS provider,
    blob3 AS outcome,
    SUM(_sample_interval) AS events,
    SUM(_sample_interval * double2) AS response_bytes,
    SUM(_sample_interval * double1) AS elapsed_ms_total
  FROM ${DOCS_SEARCH_USAGE_DATASET}
  WHERE toDate(timestamp) = toDate('${day}')
  GROUP BY day, site_id, provider, outcome
  FORMAT JSON`;
}

export async function readDailySearchUsage(input: {
  accountId: string;
  apiToken: string;
  day: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}): Promise<DocsSearchUsageRow[]> {
  const send = input.fetch ?? fetch;
  const response = await send(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/analytics_engine/sql`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${input.apiToken}` },
      body: createUsageQuery(input.day),
      signal: input.signal ?? null,
    },
  );
  if (!response.ok) {
    throw new Error(`Usage query failed with status ${response.status}.`);
  }
  return answerSchema.parse(await response.json()).data.map((row) => ({
    day: input.day,
    siteId: row.site_id,
    provider: row.provider,
    outcome: row.outcome,
    events: Math.round(row.events),
    responseBytes: Math.round(row.response_bytes),
    elapsedMsTotal: Math.round(row.elapsed_ms_total),
  }));
}

/**
 * Each run reads these days again and overwrites them. So a day finishes on the
 * day after it, and the rollup catches up after an outage of up to this length.
 */
export const DOCS_SEARCH_USAGE_LOOKBACK_DAYS = 7;

const DAY_MS = 86_400_000;

export async function rollUpSearchUsage(input: {
  accountId: string;
  apiToken: string;
  now: number;
  save(rows: readonly DocsSearchUsageRow[]): Promise<void>;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}): Promise<void> {
  for (let age = DOCS_SEARCH_USAGE_LOOKBACK_DAYS - 1; age >= 0; age -= 1) {
    const day = new Date(input.now - age * DAY_MS).toISOString().slice(0, 10);
    const rows = await readDailySearchUsage({
      accountId: input.accountId,
      apiToken: input.apiToken,
      day,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.fetch ? { fetch: input.fetch } : {}),
    });
    await input.save(rows);
  }
}
