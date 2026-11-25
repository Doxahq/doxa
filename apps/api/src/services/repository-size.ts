import type { Env } from "../env";

/** 1 GB in KB, the unit of GitHub's repository `size` field. */
export const DEFAULT_MAX_REPOSITORY_SIZE_KB = 1_048_576;

/**
 * The largest repository that a generation accepts, in KB
 * (`MAX_REPOSITORY_SIZE_KB`). A value that is not a positive integer uses
 * the default of 1 GB.
 */
export function maxRepositorySizeKbFromEnv(env: Pick<Env, "MAX_REPOSITORY_SIZE_KB"> | undefined): number {
  const raw = env?.MAX_REPOSITORY_SIZE_KB?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_MAX_REPOSITORY_SIZE_KB;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_REPOSITORY_SIZE_KB;
}

/** A repository above the limit: no clone and no model call starts. */
export interface RepositoryTooLarge {
  outcome: "repository_too_large";
  sizeKb: number;
  limitKb: number;
  message: string;
}

/** The refusal for a repository of `sizeKb`, or null when it fits the limit. */
export function checkRepositorySize(sizeKb: number | undefined, limitKb: number): RepositoryTooLarge | null {
  if (sizeKb === undefined || sizeKb <= limitKb) return null;
  return {
    outcome: "repository_too_large",
    sizeKb,
    limitKb,
    message: `This repository is ${formatSize(sizeKb)}. Doxa generates docs for repositories up to ${formatSize(limitKb)}.`,
  };
}

/** "1.5 GB", "900 MB" or "120 KB", from KB. */
function formatSize(kb: number): string {
  if (kb < 1024) return `${kb} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${oneDecimal(mb)} MB`;
  return `${oneDecimal(mb / 1024)} GB`;
}

/** 1.5, 2 or 900: one decimal, without a trailing ".0". */
function oneDecimal(value: number): string {
  return String(Math.round(value * 10) / 10);
}
