import { describe, expect, test } from "vitest";
import {
  DEFAULT_DOCS_QUALITY_MAX_REPAIRS,
  DEFAULT_DOCS_QUALITY_MAX_REPAIRS_PER_PAGE,
  DEFAULT_PAGE_FAILURE_MAX_RETRIES,
  canRetryPageFailure,
  canRunDocsQualityRepair,
  canRunDocsQualityRepairForPage,
} from "../src/doxa-agent/retry-policy";

describe("generation retry policy", () => {
  test("allows one bounded page retry by default", () => {
    expect(DEFAULT_PAGE_FAILURE_MAX_RETRIES).toBe(1);
    expect(canRetryPageFailure(0)).toBe(true);
    expect(canRetryPageFailure(1)).toBe(false);
  });

  test("honors an explicit page retry budget", () => {
    expect(canRetryPageFailure(1, 2)).toBe(true);
    expect(canRetryPageFailure(2, 2)).toBe(false);
  });

  test("bounds whole-doc quality repair passes", () => {
    expect(DEFAULT_DOCS_QUALITY_MAX_REPAIRS).toBe(3);
    expect(canRunDocsQualityRepair(2)).toBe(true);
    expect(canRunDocsQualityRepair(3)).toBe(false);
  });

  test("uses a separate per-page whole-doc quality repair budget", () => {
    expect(DEFAULT_DOCS_QUALITY_MAX_REPAIRS_PER_PAGE).toBe(2);
    expect(canRunDocsQualityRepairForPage(0)).toBe(true);
    expect(canRunDocsQualityRepairForPage(1)).toBe(true);
    expect(canRunDocsQualityRepairForPage(2)).toBe(false);
    expect(canRunDocsQualityRepairForPage(2, 3)).toBe(true);
    expect(canRunDocsQualityRepairForPage(3, 3)).toBe(false);
  });

  test("rejects invalid retry budgets", () => {
    expect(() => canRetryPageFailure(0, -1)).toThrow(/non-negative integer/i);
    expect(() => canRunDocsQualityRepair(0, 1.5)).toThrow(/non-negative integer/i);
    expect(() => canRunDocsQualityRepairForPage(-1)).toThrow(/non-negative integer/i);
  });
});
