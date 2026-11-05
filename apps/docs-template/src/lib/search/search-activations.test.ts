import { describe, expect, it } from "vitest";

import { createSearchActivations } from "./search-activations";

const result = () => {};
const recent = () => {};
const askAi = () => {};

describe("createSearchActivations", () => {
  it("ends with Ask AI when the site has chat", () => {
    expect(
      createSearchActivations({
        hasQuery: true,
        resultActions: [result],
        recentActions: [recent],
        askAi,
      })
    ).toEqual([result, askAi]);
  });

  it("has only the results when chat is off", () => {
    expect(
      createSearchActivations({
        hasQuery: true,
        resultActions: [result],
        recentActions: [recent],
        askAi: null,
      })
    ).toEqual([result]);
  });

  it("has nothing to select with no results and no chat", () => {
    expect(
      createSearchActivations({
        hasQuery: true,
        resultActions: [],
        recentActions: [recent],
        askAi: null,
      })
    ).toEqual([]);
  });

  it("shows recent searches before a query, with or without chat", () => {
    for (const ask of [askAi, null]) {
      expect(
        createSearchActivations({
          hasQuery: false,
          resultActions: [result],
          recentActions: [recent],
          askAi: ask,
        })
      ).toEqual([recent]);
    }
  });
});
