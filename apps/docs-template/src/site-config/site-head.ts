import type { ResolvedSiteConfig } from "@doxahq/site-config";

import { assetUrl } from "./asset-url";

/** The `@name` form of an X handle, which a site owner may enter with or without the `@`. */
export function formatTwitterHandle(handle: string): string | null {
  const name = handle.trim().replace(/^@+/, "");
  return name ? `@${name}` : null;
}

/**
 * The site-wide `head` of a docs site. Each page adds its own title, description
 * and canonical URL. `origin` is the origin of the request: share cards need an
 * absolute image URL, and the asset path alone is relative.
 */
export function siteHead(config: ResolvedSiteConfig, origin: string) {
  const image = config.branding.ogImage
    ? new URL(assetUrl(config.branding.ogImage), origin).toString()
    : null;
  const twitterHandle = formatTwitterHandle(config.seo.twitterHandle);
  const keywords = config.seo.keywords.join(", ");

  return {
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: config.name },
      { name: "description", content: config.description },
      ...(keywords ? [{ name: "keywords", content: keywords }] : []),
      { property: "og:type", content: "website" },
      { property: "og:title", content: config.name },
      { property: "og:description", content: config.description },
      { property: "og:site_name", content: config.name },
      {
        name: "twitter:card",
        content: image ? "summary_large_image" : "summary",
      },
      { name: "twitter:title", content: config.name },
      { name: "twitter:description", content: config.description },
      ...(twitterHandle ? [{ name: "twitter:site", content: twitterHandle }] : []),
      ...(image
        ? [
            { property: "og:image", content: image },
            { name: "twitter:image", content: image },
          ]
        : []),
    ],
    links: [
      {
        rel: "icon",
        href: config.branding.favicon
          ? assetUrl(config.branding.favicon)
          : "/favicon.svg",
      },
    ],
  };
}
