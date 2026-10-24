/** How far one production feature is rolled out across docs sites. */
export type RolloutMode = "off" | "allowlist" | "all";

export interface SiteRollout {
  mode: RolloutMode;
  siteIds: ReadonlySet<string>;
}

/**
 * Parses a rollout mode. Every unknown value fails closed to `off`; the
 * optional callback reports a value that is set but invalid.
 */
export function parseRolloutMode(
  value: string | undefined,
  onInvalid?: (value: string) => void,
): RolloutMode {
  if (value === "allowlist" || value === "all") return value;
  if (value !== undefined && value !== "off") onInvalid?.(value);
  return "off";
}

export function parseSiteAllowlist(
  value: string | undefined,
): ReadonlySet<string> {
  if (!value) return new Set();

  return new Set(
    value
      .split(",")
      .map((siteId) => siteId.trim())
      .filter(Boolean),
  );
}

export function isSiteInRollout(rollout: SiteRollout, siteId: string): boolean {
  return (
    rollout.mode === "all" ||
    (rollout.mode === "allowlist" && rollout.siteIds.has(siteId))
  );
}
