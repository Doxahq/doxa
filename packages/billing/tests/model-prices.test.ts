import { DEFAULT_DOXA_PLANNER_MODEL, DEFAULT_DOXA_WRITER_MODEL } from "@doxahq/contracts";
import { describe, expect, it } from "vitest";

import { pricedModelIds } from "./helpers/model-price-table";

/** Spec 20.1: admission refuses a run whose model has no price, so the defaults must have one. */
describe("model prices", () => {
  const priced = pricedModelIds();
  const hasPrice = (model: string) => priced.some((id) => model === id || model.startsWith(`${id}-`));

  it("reads the price table", () => {
    expect(priced.length).toBeGreaterThan(3);
  });

  it("prices the planner, the writer and the writer fallback (the planner model by default)", () => {
    for (const model of [DEFAULT_DOXA_PLANNER_MODEL, DEFAULT_DOXA_WRITER_MODEL]) expect(hasPrice(model), model).toBe(true);
  });
});
