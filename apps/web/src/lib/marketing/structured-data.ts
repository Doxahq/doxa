import { absoluteUrl, GITHUB_URL, SITE_NAME } from "~/lib/marketing/links"

/**
 * Schema.org structured data (JSON-LD) of the marketing pages, which search
 * engines read for rich results. https://developers.google.com/search/docs/appearance/structured-data
 */

type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type JsonLd = { "@context": "https://schema.org"; "@type": string } & { [key: string]: JsonValue }

const LOGO_PATH = "/doxa-github-app-logo.png"

const PUBLISHER = {
  "@type": "Organization",
  name: SITE_NAME,
  url: absoluteUrl("/"),
  logo: absoluteUrl(LOGO_PATH),
} satisfies { [key: string]: JsonValue }

export function organizationJsonLd(): JsonLd {
  return {
    "@context": "https://schema.org",
    ...PUBLISHER,
    sameAs: [GITHUB_URL],
  }
}

export function softwareApplicationJsonLd(description: string): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    description,
    url: absoluteUrl("/"),
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web",
    // The Free plan. The paid plans are on /pricing.
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  }
}

export interface BlogPostingInput {
  path: string
  title: string
  description: string
  /** `YYYY-MM-DD` */
  publishedDate: string
  author: string
  imagePath: string
}

export function blogPostingJsonLd(post: BlogPostingInput): JsonLd {
  const url = absoluteUrl(post.path)
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.description,
    datePublished: post.publishedDate,
    url,
    mainEntityOfPage: url,
    image: absoluteUrl(post.imagePath),
    author: { "@type": "Organization", name: post.author },
    publisher: PUBLISHER,
  }
}

/**
 * A `<script type="application/ld+json">` for a route `head`. `<` is escaped so
 * that a value with `</script>` cannot end the script early.
 */
export function jsonLdScript(data: JsonLd) {
  return {
    type: "application/ld+json",
    children: JSON.stringify(data).replaceAll("<", "\\u003c"),
  }
}
