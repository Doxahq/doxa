import { describe, expect, test } from "vitest";

import {
  DEFAULT_CUSTOM_DOMAIN_LIMIT,
  createDocsDomainLimitPolicy,
} from "../../src/services/docs-domain-limit-policy";

describe("docs domain limit policy", () => {
  test("uses the default limit until billing plans provide one", async () => {
    const policy = createDocsDomainLimitPolicy();

    await expect(
      policy.getLimit({ userId: "user-1", projectId: "project-1" }),
    ).resolves.toBe(DEFAULT_CUSTOM_DOMAIN_LIMIT);
    expect(DEFAULT_CUSTOM_DOMAIN_LIMIT).toBe(1);
  });
});
