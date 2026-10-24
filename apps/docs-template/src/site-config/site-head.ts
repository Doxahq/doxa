import type { ResolvedSiteConfig } from "@doxahq/site-config";

import { assetUrl } from "./asset-url";

export function siteHead(config: ResolvedSiteConfig) {
  const image = config.branding.ogImage
    ? assetUrl(config.branding.ogImage)
    : null;
  return {
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: config.name },
      { name: "description", content: config.description },
      { name: "keywords", content: config.seo.keywords.join(", ") },
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
      { name: "twitter:site", content: config.seo.twitterHandle },
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
