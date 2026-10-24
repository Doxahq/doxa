import { describe, expect, test } from "vitest";

import {
  isRuntimeMdxComponentName,
  parseRuntimeMdx,
  resolveEmbedUrl,
  type RuntimeMdxElementNode,
  type RuntimeMdxNode,
} from "../src";

function elements(nodes: readonly RuntimeMdxNode[]): RuntimeMdxElementNode[] {
  return nodes.flatMap((node) =>
    node.type === "element" ? [node, ...elements(node.children ?? [])] : [],
  );
}

function images(source: string, resolveAssetUrl?: (url: string) => string) {
  return elements(
    parseRuntimeMdx(source, resolveAssetUrl ? { resolveAssetUrl } : {}).nodes,
  ).filter((node) => node.name === "img");
}

describe("markdown images", () => {
  test("render as a lazy img with the alt text and title", () => {
    expect(images(`![Rate limits](/assets/rate-limits.png "Limits")`)).toEqual([
      {
        type: "element",
        name: "img",
        props: {
          src: "/assets/rate-limits.png",
          alt: "Rate limits",
          loading: "lazy",
          decoding: "async",
          title: "Limits",
        },
      },
    ]);
  });

  test("keep an image inside its paragraph and a link", () => {
    const [paragraph] = parseRuntimeMdx(
      `See [![Logo](https://example.com/logo.png)](https://example.com) here.`,
    ).nodes as RuntimeMdxElementNode[];
    expect(paragraph?.name).toBe("p");
    const link = paragraph?.children?.find(
      (child): child is RuntimeMdxElementNode =>
        child.type === "element" && child.name === "a",
    );
    expect(link?.children?.[0]).toMatchObject({
      name: "img",
      props: { src: "https://example.com/logo.png", alt: "Logo" },
    });
  });

  test("leave out sources the page cannot load safely", () => {
    expect(images(`![a](data:image/png;base64,AAAA)`)).toEqual([]);
    expect(images(`![a](javascript:alert(1))`)).toEqual([]);
    expect(images(`![a](//evil.example/x.png)`)).toEqual([]);
    expect(images(`![a](images/x.png)`)).toEqual([]);
  });

  test("an empty alt text stays an empty string", () => {
    expect(images(`![](/assets/x.png)`)[0]?.props?.alt).toBe("");
  });

  test("resolveAssetUrl rewrites image sources and card pictures", () => {
    const resolve = (url: string) =>
      url === "/assets/x.png" ? "/assets/x.png?v=abc" : url;
    expect(images(`![a](/assets/x.png)`, resolve)[0]?.props?.src).toBe(
      "/assets/x.png?v=abc",
    );
    expect(images(`![a](/assets/other.png)`, resolve)[0]?.props?.src).toBe(
      "/assets/other.png",
    );

    const card = elements(
      parseRuntimeMdx(`<Card title="A" image="/assets/x.png" />`, {
        resolveAssetUrl: resolve,
      }).nodes,
    ).find((node) => node.name === "Card");
    expect(card?.props?.image).toBe("/assets/x.png?v=abc");
  });
});

describe("Embed", () => {
  test("is a registered component", () => {
    expect(isRuntimeMdxComponentName("Embed")).toBe(true);
    const [node] = elements(
      parseRuntimeMdx(`<Embed url="https://youtu.be/dQw4w9WgXcQ" />`).nodes,
    ).filter((element) => element.name === "Embed");
    expect(node?.props).toEqual({ url: "https://youtu.be/dQw4w9WgXcQ" });
  });
});

describe("resolveEmbedUrl", () => {
  test.each([
    [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    ],
    [
      "https://youtu.be/dQw4w9WgXcQ?t=1m30s",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90",
    ],
    [
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    ],
    [
      "https://www.youtube.com/embed/dQw4w9WgXcQ?start=42",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42",
    ],
    ["https://vimeo.com/76979871", "https://player.vimeo.com/video/76979871"],
    [
      "https://vimeo.com/76979871/abc123def0",
      "https://player.vimeo.com/video/76979871?h=abc123def0",
    ],
    [
      "https://player.vimeo.com/video/76979871",
      "https://player.vimeo.com/video/76979871",
    ],
    [
      "https://www.loom.com/share/0123456789abcdef0123456789abcdef",
      "https://www.loom.com/embed/0123456789abcdef0123456789abcdef",
    ],
  ])("%s plays %s", (input, src) => {
    expect(resolveEmbedUrl(input)?.src).toBe(src);
  });

  test.each([
    "https://example.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=short",
    "https://vimeo.com/channels/staffpicks",
    "https://www.loom.com/share/not-an-id",
    "javascript:alert(1)",
    "not a url",
  ])("%s is not supported", (input) => {
    expect(resolveEmbedUrl(input)).toBeNull();
  });
});
