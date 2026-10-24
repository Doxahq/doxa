import { describe, expect, test } from "vitest";

import { DocsContentError } from "../../../src/services/docs-content/errors";
import {
  applyDecisionsToBranch,
  type DecidedReviewPage,
} from "../../../src/services/generation-reviews/review-decisions";
import { reviewStructure } from "../../../src/services/generation-reviews/review-changes";
import { placeMovedPages } from "../../../src/services/generation-reviews/review-moves";
import type { ReviewPagePlan } from "../../../src/services/generation-reviews/review-pages";
import { generated, main, reviewTree, type FakeNode, type FakeSite } from "./review-fixtures";

/** A page move that a person made on the review branch. */
type Move = { title: string; href: string };

/**
 * The review branch with the default decisions: the generated pages, plus
 * the two removals that still wait for a decision. `moves` renames pages by
 * their generated href, `without` leaves pages out.
 */
function branchSite(
  moves: Record<string, Move> = {},
  without: readonly string[] = [],
): FakeSite {
  const place = (node: FakeNode): FakeNode[] => {
    if (!("href" in node)) return [node];
    if (without.includes(node.href)) return [];
    return [moves[node.href] ?? node];
  };
  const bodies: Record<string, string> = {
    "/": "intro v1",
    "/install": "install v2",
    "/webhooks": "webhooks v1",
    "/pricing": "pricing by hand",
    "/faq": "faq by hand",
  };

  return {
    sections: [
      {
        slug: "default",
        label: "Docs",
        default: true,
        nodes: [
          { title: "Intro", href: "/" },
          { heading: "Guides" },
          { title: "Installation", href: "/install" },
          { title: "Webhooks", href: "/webhooks" },
          { title: "Pricing", href: "/pricing" },
        ].flatMap(place),
      },
      { slug: "faq", label: "FAQ", nodes: [{ title: "Questions", href: "/faq" }] },
    ],
    bodies: Object.fromEntries(
      Object.entries(bodies)
        .filter(([href]) => !without.includes(href))
        .map(([href, body]) => [moves[href]?.href ?? href, body]),
    ),
  };
}

function decided(
  href: string,
  change: DecidedReviewPage["change"],
  previousDecision: DecidedReviewPage["decision"],
  decision: DecidedReviewPage["decision"],
  branchHref: string | null = null,
): DecidedReviewPage {
  return { href, branchHref, change, previousDecision, decision };
}

function decide(
  branch: FakeSite,
  pages: readonly DecidedReviewPage[],
  personEdits: readonly string[] = [],
) {
  return applyDecisionsToBranch({
    branch: reviewTree(branch),
    main,
    generated,
    pages,
    isPersonEdit: (path) => personEdits.includes(path),
  });
}

function manifestPages(desired: Map<string, unknown>): Array<{ href: string; title: string }> {
  const manifest = desired.get("manifest.json");
  if (typeof manifest !== "string") throw new Error("The decision wrote no manifest.");
  const parsed: { pages: Array<{ href: string; title: string }> } = JSON.parse(manifest);
  return parsed.pages.map(({ href, title }) => ({ href, title }));
}

function manifestHrefs(desired: Map<string, unknown>): string[] {
  return manifestPages(desired).map((page) => page.href);
}

describe("applyDecisionsToBranch", () => {
  test("skips a renamed new page where the person put it", async () => {
    const moved = { title: "Hooks", href: "/hooks" };
    const result = await decide(
      branchSite({ "/webhooks": moved }),
      [decided("/webhooks", "added", "accepted", "rejected", "/hooks")],
      ["source/hooks/index.mdx"],
    );

    expect(result.desired.get("source/hooks/index.mdx")).toBeNull();
    expect(result.desired.has("source/webhooks/index.mdx")).toBe(false);
    expect(manifestHrefs(result.desired)).not.toContain("/hooks");
    expect(result.branchHrefs.get("/webhooks")).toBeNull();
  });

  test("keeps a rename of another page when it decides on a page", async () => {
    const result = await decide(
      branchSite({ "/install": { title: "Setup", href: "/setup" } }),
      [decided("/pricing", "removed", "rejected", "accepted")],
      ["source/setup/index.mdx", "source/install/index.mdx"],
    );

    expect(result.desired.get("source/pricing/index.mdx")).toBeNull();
    expect(manifestHrefs(result.desired)).toEqual(["/", "/setup", "/webhooks", "/faq"]);
    expect(result.desired.has("source/setup/index.mdx")).toBe(false);
    expect(result.desired.has("source/install/index.mdx")).toBe(false);
  });

  test("leaves the title and body of a moved page that the person edited", async () => {
    const result = await decide(
      branchSite({ "/install": { title: "Setup", href: "/setup" } }),
      [decided("/install", "modified", "rejected", "accepted", "/setup")],
      ["source/setup/index.mdx"],
    );

    expect(result.desired.has("source/setup/index.mdx")).toBe(false);
    expect(manifestPages(result.desired)).toContainEqual({ href: "/setup", title: "Setup" });
    expect(result.branchHrefs.size).toBe(0);
  });

  test("writes the chosen version of a page that nobody edited", async () => {
    const result = await decide(branchSite(), [
      decided("/install", "modified", "accepted", "rejected"),
    ]);

    expect(result.desired.get("source/install/index.mdx")).toBe("install v1");
    expect(manifestPages(result.desired)).toContainEqual({ href: "/install", title: "Install" });
  });

  test("brings a skipped new page back at its own href", async () => {
    const result = await decide(branchSite({}, ["/webhooks"]), [
      decided("/webhooks", "added", "rejected", "accepted"),
    ]);

    expect(result.desired.get("source/webhooks/index.mdx")).toBe("webhooks v1");
    expect(manifestHrefs(result.desired)).toContain("/webhooks");
  });

  test("refuses to bring a page back over a page that took its href", async () => {
    // A person moved Pricing to the href that the skipped page left.
    const branch = branchSite({ "/pricing": { title: "Pricing", href: "/webhooks" } }, ["/webhooks"]);

    await expect(
      decide(branch, [decided("/webhooks", "added", "rejected", "accepted")]),
    ).rejects.toBeInstanceOf(DocsContentError);
  });
});

describe("placeMovedPages", () => {
  const plan = (
    href: string,
    change: ReviewPagePlan["change"],
    decision: ReviewPagePlan["decision"],
    branchHref: string | null,
  ): ReviewPagePlan => ({
    href,
    branchHref,
    title: href,
    change,
    decision,
    reasons: [],
    decidedAt: null,
    decidedByUserId: null,
  });

  test("keeps a page that a person moved where the person put it", () => {
    const pages = [plan("/webhooks", "added", "accepted", "/hooks")];
    const placement = placeMovedPages({
      structure: reviewStructure(main, generated, pages),
      branch: reviewTree(branchSite({ "/webhooks": { title: "Hooks", href: "/hooks" } })),
      pages,
      prior: pages,
    });

    const hrefs = placement.structure.pages.map((page) => page.href);
    expect(hrefs).toContain("/hooks");
    expect(hrefs).not.toContain("/webhooks");
    expect(placement.pages[0]?.branchHref).toBe("/hooks");
    expect(placement.released).toEqual([]);
  });

  test("releases a move whose page the run takes off the branch or no longer changes", () => {
    const pages = [plan("/webhooks", "added", "rejected", "/hooks")];
    const placement = placeMovedPages({
      structure: reviewStructure(main, generated, pages),
      branch: reviewTree(branchSite({ "/webhooks": { title: "Hooks", href: "/hooks" } })),
      pages,
      prior: [...pages, { href: "/old", branchHref: "/older" }],
    });

    expect(placement.pages[0]?.branchHref).toBeNull();
    expect(placement.released).toEqual([
      { href: "/webhooks", branchHref: "/hooks" },
      { href: "/old", branchHref: "/older" },
    ]);
  });
});
