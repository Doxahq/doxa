/**
 * The default account-wide number of concurrent page writer model calls.
 * Anthropic rate limits apply to the whole organization, so this number must
 * stay under the concurrent-request headroom of the account's tier. Set
 * `DOXA_ACCOUNT_WRITER_SLOTS` to change it without a code change.
 */
export const DEFAULT_ACCOUNT_WRITER_SLOTS = 48;

/** A positive integer, else the default. */
export function parseAccountWriterSlots(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_ACCOUNT_WRITER_SLOTS;
}
