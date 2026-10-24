import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { PLANNER_OUTPUT_SCHEMA_HASH, PLANNING_FINGERPRINT_VERSION } from "@doxahq/contracts";

import { STRUCTURE_RESPONSE_SCHEMA } from "../src/doxa-agent/response-schemas";
import { STRUCTURE_REVIEW_RESPONSE_SCHEMA } from "../src/doxa-agent/structure-review";

describe("planner output contract", () => {
  test("a change of the planner's output format comes with a new planning version", () => {
    const schemaHash = createHash("sha256")
      .update(JSON.stringify([STRUCTURE_RESPONSE_SCHEMA, STRUCTURE_REVIEW_RESPONSE_SCHEMA]))
      .digest("hex");

    expect(
      schemaHash,
      `The planner output schemas changed. Bump PLANNING_FINGERPRINT_VERSION (now ${PLANNING_FINGERPRINT_VERSION}) ` +
        "in @doxahq/contracts and set PLANNER_OUTPUT_SCHEMA_HASH to the new hash.",
    ).toBe(PLANNER_OUTPUT_SCHEMA_HASH);
  });
});
