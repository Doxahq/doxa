import { resolveSiteConfig } from "@doxahq/site-config";
import { describe, expect, it } from "vitest";

import { formatTwitterHandle, siteHead } from "./site-head";

const ORIGIN = "https://docs.example.com";
const OG_IMAGE = `asset:${"b".repeat(64)}`;

type HeadMeta = ReturnType<typeof siteHead>["meta"][number];

function metaContent(meta: HeadMeta[], key: string): string | undefined {
  const tag = meta.find(
    (entry) =>
      ("name" in entry && entry.name === key) ||
      ("property" in entry && entry.property === key)
  );
  return tag && "content" in tag ? tag.content : undefined;
}

describe("siteHead", () => {
  it("leaves out empty keywords and an empty X handle", () => {
    const { meta } = siteHead(resolveSiteConfig({ name: "Acme" }), ORIGIN);

    expect(metaContent(meta, "keywords")).toBeUndefined();
    expect(metaContent(meta, "twitter:site")).toBeUndefined();
    expect(metaContent(meta, "twitter:card")).toBe("summary");
    expect(metaContent(meta, "og:image")).toBeUndefined();
  });

  it("names the X handle and the keywords when the site sets them", () => {
    const config = resolveSiteConfig({
      name: "Acme",
      seo: { keywords: ["widgets", "api"], twitterHandle: "acme" },
    });
    const { meta } = siteHead(config, ORIGIN);

    expect(metaContent(meta, "keywords")).toBe("widgets, api");
    expect(metaContent(meta, "twitter:site")).toBe("@acme");
  });

  it("gives the share image as an absolute URL on the request origin", () => {
    const config = resolveSiteConfig({
      name: "Acme",
      branding: { ogImage: OG_IMAGE },
    });
    const { meta } = siteHead(config, ORIGIN);
    const imageUrl = `${ORIGIN}/_doxa/assets/${"b".repeat(64)}`;

    expect(metaContent(meta, "og:image")).toBe(imageUrl);
    expect(metaContent(meta, "twitter:image")).toBe(imageUrl);
    expect(metaContent(meta, "twitter:card")).toBe("summary_large_image");
  });
});

describe("formatTwitterHandle", () => {
  it.each([
    ["acme", "@acme"],
    ["@acme", "@acme"],
    ["  @@acme ", "@acme"],
    ["", null],
    ["  @ ", null],
  ])("formats %j as %j", (input, expected) => {
    expect(formatTwitterHandle(input)).toBe(expected);
  });
});
