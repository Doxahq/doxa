import type { GenerationLogLevel, GenerationLogPhase } from "@doxahq/contracts";

/** One line of the generation log that people read. */
export interface GenerationLogLine {
  phase: GenerationLogPhase;
  message: string;
  level: GenerationLogLevel;
}

/** A rule returns it for an event that the log does not show. */
export const hidden = null;

export function line(
  phase: GenerationLogPhase,
  message: string,
  level: GenerationLogLevel = "info",
): GenerationLogLine {
  return { phase, message, level };
}

export function numberField(data: Record<string, unknown>, key: string): number | null {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function stringField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function pageCount(value: number | string): string {
  return `${value} ${Number(value) === 1 ? "page" : "pages"}`;
}

/** "attempt 2 of 3" from the attempt counters of a retry message. */
export function attemptText(attempt: number | string, max: number | string): string {
  return `attempt ${attempt} of ${max}`;
}

export function quoted(title: string): string {
  return `"${title.trim()}"`;
}

/** The first 7 characters of a commit SHA, as Git shows it. */
export function shortCommit(revision: string): string {
  return /^[0-9a-f]{8,}$/i.test(revision) ? revision.slice(0, 7) : revision;
}
