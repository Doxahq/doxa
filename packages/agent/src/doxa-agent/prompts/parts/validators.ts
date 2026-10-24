/**
 * Part Prompt Validators
 * Post-generation validation and auto-fix for part prompt constraints.
 */

import type { PartPrompt, PartValidationResult } from "./types";

/** Words to drop when truncating at the end */
const TRAILING_FILLER = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to",
  "for", "of", "with", "by", "from", "as", "is", "are", "was",
  "were", "be", "been", "being", "that", "this", "these", "those",
]);

/**
 * Validate a value against a part prompt's constraints and auto-fix where possible.
 * Returns the original value if valid, or a fixed value with a list of issues.
 */
export function validatePartValue(
  partPrompt: PartPrompt,
  value: string
): PartValidationResult {
  const issues: string[] = [];
  let fixed = value.trim();

  // Step 1: Strip anti-pattern prefixes
  if (partPrompt.antiPatterns) {
    for (const pattern of partPrompt.antiPatterns) {
      if (pattern.test(fixed)) {
        fixed = fixed.replace(pattern, "");
        issues.push(`Stripped anti-pattern prefix matching ${pattern}`);
      }
    }
    // Capitalize first letter after stripping
    if (fixed.length > 0 && issues.length > 0) {
      fixed = fixed.charAt(0).toUpperCase() + fixed.slice(1);
    }
  }

  const { constraints } = partPrompt;

  // Step 2: Truncate to maxWords
  if (constraints.maxWords) {
    const words = fixed.split(/\s+/);
    if (words.length > constraints.maxWords) {
      let truncated = words.slice(0, constraints.maxWords);
      // Drop trailing filler words for a clean cut
      while (
        truncated.length > (constraints.minWords ?? 1) &&
        TRAILING_FILLER.has(truncated[truncated.length - 1].toLowerCase())
      ) {
        truncated.pop();
      }
      fixed = truncated.join(" ");
      issues.push(
        `Truncated from ${words.length} to ${truncated.length} words (max ${constraints.maxWords})`
      );
    }
  }

  // Step 3: Check minWords
  if (constraints.minWords) {
    const words = fixed.split(/\s+/).filter(Boolean);
    if (words.length < constraints.minWords) {
      issues.push(
        `Too short: ${words.length} words (min ${constraints.minWords})`
      );
    }
  }

  // Step 4: Check maxChars
  if (constraints.maxChars && fixed.length > constraints.maxChars) {
    fixed = fixed.slice(0, constraints.maxChars).trim();
    issues.push(`Truncated to ${constraints.maxChars} chars`);
  }

  // Step 5: Check pattern
  if (constraints.pattern && !constraints.pattern.test(fixed)) {
    issues.push(`Does not match required pattern ${constraints.pattern}`);
  }

  // Step 6: Run custom validator
  if (constraints.validate) {
    const customFix = constraints.validate(fixed);
    if (customFix !== null) {
      fixed = customFix;
      issues.push("Applied custom validation fix");
    }
  }

  return {
    valid: issues.length === 0,
    original: value,
    fixed,
    issues,
  };
}
