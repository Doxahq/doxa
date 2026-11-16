import type { BlogPostMeta } from "~/lib/marketing/blog"
import { DEFAULT_SOCIAL_IMAGE, marketingHead, type SocialImage } from "~/lib/marketing/seo"
import { blogPostingJsonLd } from "~/lib/marketing/structured-data"

/** A post shares its own cover. A post with the drawn cover shares the site image. */
function postImage(post: BlogPostMeta): SocialImage {
  return post.cover ? { path: post.cover, alt: post.title } : DEFAULT_SOCIAL_IMAGE
}

/** The `head` of a blog post: the share tags of an article and its `BlogPosting` data. */
export function blogPostHead(post: BlogPostMeta) {
  const path = `/blog/${post.slug}`
  const image = postImage(post)
  return marketingHead({
    path,
    title: `${post.title} — Doxa`,
    description: post.description,
    image,
    article: { publishedDate: post.date, author: post.author },
    structuredData: [
      blogPostingJsonLd({
        path,
        title: post.title,
        description: post.description,
        publishedDate: post.date,
        author: post.author,
        imagePath: image.path,
      }),
    ],
  })
}
