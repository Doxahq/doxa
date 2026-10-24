import type { ValidationIssue } from "@doxahq/contracts/validation";
import { createValidationIssue } from "@doxahq/contracts/validation-messages";
import { isRecord } from "./pointer";

export const SITE_CONFIG_LIMITS = {
  configBytes: 64 * 1024,
  themeBytes: 32 * 1024,
  nestingDepth: 8,
  lenientPasses: 32,
} as const;

function exceedsDepth(value: unknown, depth: number): boolean {
  if (!Array.isArray(value) && !isRecord(value)) return false;
  if (depth > SITE_CONFIG_LIMITS.nestingDepth) return true;
  return Object.values(value).some((child) => exceedsDepth(child, depth + 1));
}

export function validateInputLimits(
  input: unknown,
  maxBytes: number = SITE_CONFIG_LIMITS.configBytes,
): ValidationIssue[] {
  try {
    if (exceedsDepth(input, 1)) return [createValidationIssue("too_deep")];
    const text = JSON.stringify(input);
    if (text === undefined) return [createValidationIssue("invalid_type")];
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      return [createValidationIssue("config_too_large", "", { max: maxBytes })];
    }
    return [];
  } catch {
    return [createValidationIssue("invalid_type")];
  }
}
