/** Why a provider will not send to an address, in terms that do not depend on the provider. */
export type SuppressionReason = "bounce" | "complaint" | "provider" | "manual";

export interface ProviderSuppression {
  /** Lowercase. */
  readonly email: string;
  readonly reason: SuppressionReason;
}

export interface SuppressionPage {
  readonly entries: readonly ProviderSuppression[];
  /** `null` on the last page. */
  readonly nextCursor: string | null;
}

/**
 * Reads the provider's own suppression list, so Doxa can copy it into
 * `email_suppressions` (email spec §9.1). Doxa then keeps the list after a
 * provider swap. Only permanent entries are returned: a temporary one
 * (for example a soft bounce) expires on its own.
 */
export interface EmailSuppressionSource {
  readonly provider: string;
  listSuppressions(cursor: string | null): Promise<SuppressionPage>;
}
