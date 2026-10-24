import { describe, expect, test, vi } from "vitest";

import {
  isSiteInRollout,
  parseRolloutMode,
  parseSiteAllowlist,
} from "../src/rollout-policy";

describe("rollout policy", () => {
  test.each(["off", "allowlist", "all"] as const)(
    "accepts the %s mode without a report",
    (mode) => {
      const onInvalid = vi.fn();
      expect(parseRolloutMode(mode, onInvalid)).toBe(mode);
      expect(onInvalid).not.toHaveBeenCalled();
    },
  );

  test("treats a missing mode as off without a report", () => {
    const onInvalid = vi.fn();
    expect(parseRolloutMode(undefined, onInvalid)).toBe("off");
    expect(onInvalid).not.toHaveBeenCalled();
  });

  test.each(["", "ALL", "sometimes"])(
    "fails closed and reports the invalid mode %j",
    (value) => {
      const onInvalid = vi.fn();
      expect(parseRolloutMode(value, onInvalid)).toBe("off");
      expect(onInvalid).toHaveBeenCalledWith(value);
    },
  );

  test("includes a site only in its rollout", () => {
    const siteIds = parseSiteAllowlist("site-1, site-2");
    expect(isSiteInRollout({ mode: "all", siteIds: new Set() }, "site-3")).toBe(
      true,
    );
    expect(isSiteInRollout({ mode: "allowlist", siteIds }, "site-2")).toBe(
      true,
    );
    expect(isSiteInRollout({ mode: "allowlist", siteIds }, "site-3")).toBe(
      false,
    );
    expect(isSiteInRollout({ mode: "off", siteIds }, "site-1")).toBe(false);
  });
});
