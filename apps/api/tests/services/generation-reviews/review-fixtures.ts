import { sourcePathForHref } from "@doxahq/docs-engine";

import { contentStructureFromArtifacts } from "../../../src/services/docs-content/structure";
import type { ReviewTree } from "../../../src/services/generation-reviews/review-tree";

export type FakeNode = { heading: string } | { title: string; href: string };

export interface FakeSection {
  slug: string;
  label: string;
  default?: boolean;
  nodes: FakeNode[];
}

export interface FakeSite {
  sections: FakeSection[];
  bodies: Record<string, string>;
  siteConfig?: string;
}

export function reviewTree(site: FakeSite): ReviewTree {
  const pages = site.sections.flatMap((section) =>
    section.nodes.flatMap((node) =>
      "href" in node
        ? [{ ...node, sourcePath: sourcePathForHref(node.href) }]
        : [],
    ),
  );
  const manifest = { pages } as Parameters<
    typeof contentStructureFromArtifacts
  >[0];
  const structure = contentStructureFromArtifacts(
    manifest,
    site.sections.map(({ slug, label, default: isDefault }) => ({
      slug,
      label,
      ...(isDefault ? { default: true } : {}),
    })),
    new Map(site.sections.map((section) => [section.slug, section.nodes])),
  );
  const files = new Map<string, string>(
    Object.entries(site.bodies).map(([href, body]) => [
      sourcePathForHref(href),
      body,
    ]),
  );
  if (site.siteConfig) files.set("settings/site.json", site.siteConfig);

  return {
    structure,
    sectionSlugs: site.sections.map((section) => section.slug),
    manifest,
    read: async (path) => files.get(path) ?? null,
    page: (href) => structure.pages.find((page) => page.href === href) ?? null,
  };
}

export const MAIN_SITE: FakeSite = {
  sections: [
    {
      slug: "default",
      label: "Docs",
      default: true,
      nodes: [
        { title: "Intro", href: "/" },
        { heading: "Guides" },
        { title: "Install", href: "/install" },
        { title: "Pricing", href: "/pricing" },
      ],
    },
    {
      slug: "faq",
      label: "FAQ",
      nodes: [{ title: "Questions", href: "/faq" }],
    },
  ],
  bodies: {
    "/": "intro v1",
    "/install": "install v1",
    "/pricing": "pricing by hand",
    "/faq": "faq by hand",
  },
  siteConfig: '{"name":"Example"}\n',
};

export const GENERATED_SITE: FakeSite = {
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
      ],
    },
  ],
  bodies: {
    "/": "intro v1",
    "/install": "install v2",
    "/webhooks": "webhooks v1",
  },
  siteConfig: '{"name":"Example","features":{"apiPlayground":true}}\n',
};

export const main = reviewTree(MAIN_SITE);
export const generated = reviewTree(GENERATED_SITE);
