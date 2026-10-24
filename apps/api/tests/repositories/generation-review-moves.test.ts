import { describe, expect, test } from "vitest";

import { followMoves } from "../../src/repositories/generation-review-records";

describe("followMoves", () => {
  test("moves a review page from wherever it is on the branch", () => {
    const pages = [
      { href: "/webhooks", branchHref: null },
      { href: "/install", branchHref: "/setup" },
      { href: "/pricing", branchHref: null },
    ];

    const moved = followMoves(pages, [
      { from: "/webhooks", to: "/hooks" },
      { from: "/setup", to: "/install" },
      { from: "/unrelated", to: "/elsewhere" },
    ]);

    expect([...moved]).toEqual([
      ["/webhooks", "/hooks"],
      ["/install", "/install"],
    ]);
  });
});
