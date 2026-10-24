import { describe, expect, test } from "vitest";
import type { GenerationReviewPageDecision } from "@doxahq/contracts/generation-reviews";
import {
  desiredReviewChanges,
  reviewStructure,
} from "../../../src/services/generation-reviews/review-changes";
import {
  compareReviewTrees,
  planRunPages,
  type ReviewPageState,
} from "../../../src/services/generation-reviews/review-pages";
import { generated, main, reviewTree } from "./review-fixtures";

const defaultStates: readonly ReviewPageState[] = [
  { href: "/install", branchHref: null, change: "modified", decision: "accepted" },
  { href: "/webhooks", branchHref: null, change: "added", decision: "accepted" },
  { href: "/pricing", branchHref: null, change: "removed", decision: "pending" },
  { href: "/faq", branchHref: null, change: "removed", decision: "pending" },
];

function states(
  decisions: Record<string, GenerationReviewPageDecision> = {},
): ReviewPageState[] {
  return defaultStates.map((page) => ({
    ...page,
    decision: decisions[page.href] ?? page.decision,
  }));
}

function navigation(structure: ReturnType<typeof reviewStructure>) {
  return structure.sections.map((section) => ({
    slug: section.slug,
    nodes: section.nodes,
  }));
}

describe("compareReviewTrees", () => {
  test("lists changed, new, and missing pages, and skips equal pages", async () => {
    const pages = await compareReviewTrees(main, generated);

    expect(pages).toEqual([
      {
        href: "/install",
        title: "Installation",
        change: "modified",
        reasons: [{ kind: "content_rewritten" }],
      },
      {
        href: "/webhooks",
        title: "Webhooks",
        change: "added",
        reasons: [{ kind: "new_page" }],
      },
      {
        href: "/pricing",
        title: "Pricing",
        change: "removed",
        reasons: [{ kind: "missing_from_generation" }],
      },
      {
        href: "/faq",
        title: "Questions",
        change: "removed",
        reasons: [{ kind: "missing_from_generation" }],
      },
    ]);
  });

  test("starts every page with the generation's change, a removal included", async () => {
    const planned = planRunPages(await compareReviewTrees(main, generated), []);

    expect(planned.map(({ href, decision }) => ({ href, decision }))).toEqual([
      { href: "/install", decision: "accepted" },
      { href: "/webhooks", decision: "accepted" },
      { href: "/pricing", decision: "accepted" },
      { href: "/faq", decision: "accepted" },
    ]);
  });

  test("starts a page that a person owns with the generation's change, and says it is owned", async () => {
    const planned = planRunPages(await compareReviewTrees(main, generated), [], {
      lockedHrefs: new Set(["/install", "/pricing", "/webhooks"]),
    });

    expect(
      planned.map(({ href, decision, reasons }) => ({
        href,
        decision,
        owned: reasons.some((reason) => reason.kind === "owned_by_person"),
      })),
    ).toEqual([
      { href: "/install", decision: "accepted", owned: true },
      { href: "/webhooks", decision: "accepted", owned: false },
      { href: "/pricing", decision: "accepted", owned: true },
      { href: "/faq", decision: "accepted", owned: false },
    ]);
  });
});

describe("reviewStructure", () => {
  test("keeps pending removals where the published site has them", () => {
    const structure = reviewStructure(main, generated, states());

    // Pricing follows Install on the published site, so it comes back right after it.
    expect(navigation(structure)).toEqual([
      {
        slug: "default",
        nodes: [
          { title: "Intro", href: "/" },
          { heading: "Guides" },
          { title: "Installation", href: "/install" },
          { title: "Pricing", href: "/pricing" },
          { title: "Webhooks", href: "/webhooks" },
        ],
      },
      { slug: "faq", nodes: [{ title: "Questions", href: "/faq" }] },
    ]);
    expect(structure.pages.map((page) => page.href).sort()).toEqual([
      "/",
      "/faq",
      "/install",
      "/pricing",
      "/webhooks",
    ]);
  });

  test("applies accepted removals, rejected additions, and rejected rewrites", () => {
    const structure = reviewStructure(
      main,
      generated,
      states({
        "/pricing": "accepted",
        "/faq": "accepted",
        "/webhooks": "rejected",
        "/install": "rejected",
      }),
    );

    expect(navigation(structure)).toEqual([
      {
        slug: "default",
        nodes: [
          { title: "Intro", href: "/" },
          { heading: "Guides" },
          { title: "Install", href: "/install" },
        ],
      },
    ]);
    expect(structure.pages.find((page) => page.href === "/install")?.title).toBe(
      "Install",
    );
  });

  test("brings back a heading that the generation dropped", () => {
    const flat = reviewTree({
      sections: [
        {
          slug: "default",
          label: "Docs",
          default: true,
          nodes: [{ title: "Intro", href: "/" }],
        },
      ],
      bodies: { "/": "intro v1" },
    });

    const structure = reviewStructure(main, flat, [
      { href: "/pricing", branchHref: null, change: "removed", decision: "rejected" },
    ]);

    expect(structure.sections[0]?.nodes).toEqual([
      { title: "Intro", href: "/" },
      { heading: "Guides" },
      { title: "Pricing", href: "/pricing" },
    ]);
  });
});

describe("desiredReviewChanges", () => {
  test("writes generated bodies, keeps pending removals, and adds the site config", async () => {
    const desired = await desiredReviewChanges({
      main,
      generated,
      pages: states(),
    });

    expect(desired.get("source/install/index.mdx")).toBe("install v2");
    expect(desired.get("source/webhooks/index.mdx")).toBe("webhooks v1");
    expect(desired.get("source/pricing/index.mdx")).toBe("pricing by hand");
    expect(desired.get("source/faq/index.mdx")).toBe("faq by hand");
    expect(desired.get("settings/site.json")).toContain("apiPlayground");
    expect(desired.has("manifest.json")).toBe(true);
    expect(desired.has("settings/sections.json")).toBe(true);
  });

  test("deletes accepted removals and drops a section that becomes empty", async () => {
    const desired = await desiredReviewChanges({
      main,
      generated,
      pages: states({ "/pricing": "accepted", "/faq": "accepted" }),
    });

    expect(desired.get("source/pricing/index.mdx")).toBeNull();
    expect(desired.get("source/faq/index.mdx")).toBeNull();
    expect(desired.get("settings/documents.faq.json")).toBeNull();
  });

  test("restores the published body of a rejected rewrite and removes a rejected page", async () => {
    const desired = await desiredReviewChanges({
      main,
      generated,
      pages: states({ "/install": "rejected", "/webhooks": "rejected" }),
    });

    expect(desired.get("source/install/index.mdx")).toBe("install v1");
    expect(desired.get("source/webhooks/index.mdx")).toBeNull();
  });

  test("leaves the body of a page that a person moved to the person", async () => {
    const desired = await desiredReviewChanges({
      main,
      generated,
      pages: states().map((page) =>
        page.href === "/webhooks" ? { ...page, branchHref: "/hooks" } : page,
      ),
    });

    expect(desired.has("source/webhooks/index.mdx")).toBe(false);
    expect(desired.has("source/hooks/index.mdx")).toBe(false);
    expect(desired.get("source/install/index.mdx")).toBe("install v2");
  });
});
