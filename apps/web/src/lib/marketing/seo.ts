import { absoluteUrl, SITE_NAME } from "~/lib/marketing/links"
import { jsonLdScript, type JsonLd } from "~/lib/marketing/structured-data"

/**
 * The search and social tags of the marketing pages: canonical URL, Open Graph,
 * Twitter card and structured data. Each marketing route builds its `head` with
 * `marketingHead`, so every page has the same full set of tags.
 */

export interface SocialImage {
  /** A path in `public`, such as `/marketing/og/doxa.png`. */
  path: string
  alt: string
  width?: number
  height?: number
}

/** The share image of every page that has no image of its own. */
export const DEFAULT_SOCIAL_IMAGE: SocialImage = {
  path: "/marketing/og/doxa.png",
  alt: "Doxa: documentation that updates itself",
  width: 1200,
  height: 630,
}

interface ArticleDetails {
  /** `YYYY-MM-DD` */
  publishedDate: string
  author: string
}

export interface MarketingPageSeo {
  /** The path of the page, such as `/pricing`. It gives the canonical URL. */
  path: string
  title: string
  description: string
  image?: SocialImage
  /** A blog post. Without it, the page is a plain website page. */
  article?: ArticleDetails
  structuredData?: readonly JsonLd[]
}

function imageMeta(image: SocialImage) {
  const url = absoluteUrl(image.path)
  return [
    { property: "og:image", content: url },
    { property: "og:image:alt", content: image.alt },
    ...(image.width && image.height
      ? [
          { property: "og:image:width", content: String(image.width) },
          { property: "og:image:height", content: String(image.height) },
        ]
      : []),
    { name: "twitter:image", content: url },
    { name: "twitter:image:alt", content: image.alt },
  ]
}

function articleMeta(article: ArticleDetails) {
  return [
    { property: "article:published_time", content: article.publishedDate },
    { property: "article:author", content: article.author },
  ]
}

/** The `head` of a marketing route. */
export function marketingHead(page: MarketingPageSeo) {
  const url = absoluteUrl(page.path)
  return {
    meta: [
      { title: page.title },
      { name: "description", content: page.description },
      { property: "og:type", content: page.article ? "article" : "website" },
      { property: "og:site_name", content: SITE_NAME },
      { property: "og:url", content: url },
      { property: "og:title", content: page.title },
      { property: "og:description", content: page.description },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: page.title },
      { name: "twitter:description", content: page.description },
      ...imageMeta(page.image ?? DEFAULT_SOCIAL_IMAGE),
      ...(page.article ? articleMeta(page.article) : []),
    ],
    links: [{ rel: "canonical", href: url }],
    scripts: (page.structuredData ?? []).map(jsonLdScript),
  }
}
