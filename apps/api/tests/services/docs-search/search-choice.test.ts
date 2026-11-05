import { FREE_PLAN_SEARCH_POLICY, PAID_PLAN_SEARCH_POLICY } from "@doxahq/contracts/entitlements";
import { FREE_PLAN_ENTITLEMENTS } from "@doxahq/site-config";
import { describe, expect, it, vi } from "vitest";

import { assertSearchChoiceAllowed } from "../../../src/services/docs-content/site-config";

const entitlements = (policy: typeof FREE_PLAN_SEARCH_POLICY | typeof PAID_PLAN_SEARCH_POLICY) => ({
  getProjectEntitlements: async () => ({ ...FREE_PLAN_ENTITLEMENTS }),
  getSearchPolicy: async () => policy,
});

const check = (input: {
  choice: "typesense" | "minisearch" | undefined;
  previous?: string;
  policy?: typeof FREE_PLAN_SEARCH_POLICY | typeof PAID_PLAN_SEARCH_POLICY;
}) =>
  assertSearchChoiceAllowed({
    choice: input.choice,
    readPreviousChoice: async () => input.previous,
    projectId: "p",
    entitlements: entitlements(input.policy ?? FREE_PLAN_SEARCH_POLICY),
  });

describe("search choice on save", () => {
  // SECURITY REGRESSION GUARDRAIL: a free site cannot choose Typesense.
  it("refuses a new choice that the plan does not allow", async () => {
    await expect(check({ choice: "typesense" })).rejects.toMatchObject({
      name: expect.stringContaining("Validation"),
    });
  });

  it("allows what the plan allows, and no choice at all", async () => {
    await expect(check({ choice: "minisearch" })).resolves.toBeUndefined();
    await expect(check({ choice: undefined })).resolves.toBeUndefined();
    await expect(
      check({ choice: "typesense", policy: PAID_PLAN_SEARCH_POLICY }),
    ).resolves.toBeUndefined();
  });

  // PRODUCT REGRESSION GUARDRAIL: a downgrade must not block other edits.
  it("lets a site that lost its plan keep its stored choice", async () => {
    await expect(
      check({ choice: "typesense", previous: "typesense" }),
    ).resolves.toBeUndefined();
  });

  it("reads the stored choice only when it matters", async () => {
    const readPreviousChoice = vi.fn(async () => undefined);
    await assertSearchChoiceAllowed({
      choice: "minisearch",
      readPreviousChoice,
      projectId: "p",
      entitlements: entitlements(FREE_PLAN_SEARCH_POLICY),
    });
    expect(readPreviousChoice).not.toHaveBeenCalled();
  });
});
