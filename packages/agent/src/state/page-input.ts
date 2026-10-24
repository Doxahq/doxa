import type { SourceEvidence } from "../types";

/**
 * The parts of a page's evidence that change what the writer reads: the file
 * paths, sorted and without repeats. The kind and the label of each file only
 * describe it, so a planner that drops or adds them asks for the same page.
 */
export function evidencePaths(evidence: readonly SourceEvidence[] | undefined): string[] {
  return [...new Set((evidence ?? []).map((item) => item.path.trim()).filter(Boolean))].sort();
}

/** A page brief with its whitespace normalized, so a reflowed description asks for the same page. */
export function normalizedBrief(text: string | undefined): string {
  return (text ?? "").trim().replace(/\s+/g, " ");
}
