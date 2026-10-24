import { describe, expect, test } from "vitest";
import type {
  ContainerArtifactFile,
  RuntimeDocsNavigation,
} from "@doxahq/contracts";
import { validateArtifactLinks } from "../src/index";

describe("artifact link validation", () => {
  test("accepts internal links whose routes exist in final navigation", () => {
    expect(validateArtifactLinks(
      artifactFiles(
        "[Install](/guides/install)\n\n<a href=\"/overview#usage\">Usage</a>",
        "# Install\n\n[External](https://example.com)",
      ),
      navigation(["default/overview.md", "guides/install.md"]),
    )).toEqual([]);
  });

  test("treats a link to a section index page as the section route", () => {
    expect(validateArtifactLinks(
      artifactFiles("[REST API](/rest-api/index) and [again](/rest-api/) and [guide](/guides/install/index)", "# Install"),
      navigation(["default/overview.md", "guides/install.md", "rest-api/index.md"]),
    )).toEqual([]);
  });

  test("reports a page and route for an internal link missing from final navigation", () => {
    expect(validateArtifactLinks(
      artifactFiles(
        [
          "[Missing](/missing?source=overview#usage)",
          "[Missing again](/missing)",
          "[Local section](#usage)",
          "![Asset](/images/logo.png)",
        ].join("\n\n"),
        "# Install",
      ),
      navigation(["default/overview.md", "guides/install.md"]),
    )).toEqual([
      {
        page: "/overview",
        route: "/missing",
      },
    ]);
  });
});

function artifactFiles(
  overviewContent: string,
  installContent: string,
): ContainerArtifactFile[] {
  const pages = [
    {
      title: "Overview",
      href: "/overview",
      sourcePath: "source/overview/index.mdx",
    },
    {
      title: "Install",
      href: "/guides/install",
      sourcePath: "source/guides/install/index.mdx",
    },
  ];
  return [
    {
      path: "source/overview/index.mdx",
      content: overviewContent,
      contentType: "text/plain; charset=utf-8",
    },
    {
      path: "source/guides/install/index.mdx",
      content: installContent,
      contentType: "text/plain; charset=utf-8",
    },
    {
      path: "manifest.json",
      content: JSON.stringify({
        siteId: "site-1",
        versionId: "version-1",
        projectSlug: "demo",
        generatedAt: "2026-07-30T00:00:00.000Z",
        pages,
      }),
      contentType: "application/json; charset=utf-8",
    },
  ];
}

function navigation(items: string[]): RuntimeDocsNavigation {
  return {
    sections: [
      {
        slug: "default",
        items: items.filter((item) => item.startsWith("default/")),
      },
      {
        slug: "guides",
        items: items.filter((item) => item.startsWith("guides/")),
      },
      {
        slug: "rest-api",
        items: items.filter((item) => item.startsWith("rest-api/")),
      },
    ],
  };
}
