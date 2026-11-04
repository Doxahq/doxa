import { createPre, createProseComponents, RuntimeMdxContent } from "@doxahq/docs-prose"
import { Link } from "@tanstack/react-router"
import { Check, Copy } from "lucide-react"
import { Band } from "~/components/marketing/band"
import { BlogCover } from "~/components/marketing/blog/blog-cover"
import { BlogToc } from "~/components/marketing/blog/blog-toc"
import { Hr } from "~/components/marketing/guides"
import { MarketingPage } from "~/components/marketing/marketing-page"
import { SiteFooter } from "~/components/marketing/site-footer"
import { SiteNav } from "~/components/marketing/site-nav"
import { BANDS } from "~/lib/marketing/bands"
import type { BlogPost, BlogPostMeta } from "~/lib/marketing/blog"
import { SITE_ORIGIN } from "~/lib/marketing/links"

const proseComponents = createProseComponents({
  overrides: { pre: createPre({ copy: Copy, copied: Check }) },
})

function shareLinks({ slug, title }: BlogPostMeta) {
  const url = encodeURIComponent(`${SITE_ORIGIN}/blog/${slug}`)
  return [
    { label: "X", href: `https://x.com/intent/post?url=${url}&text=${encodeURIComponent(title)}` },
    { label: "LinkedIn", href: `https://www.linkedin.com/sharing/share-offsite/?url=${url}` },
  ]
}

/** A post: hero, then the cover and the article next to a sticky sidebar. */
export function BlogPostPage({ post }: { post: BlogPost }) {
  return (
    <MarketingPage page="blog">
      <header className="hero">
        <div className="hero__glow" aria-hidden="true" />
        <SiteNav current="blog" />
        <Hr />
        <div className="col">
          <div className="hero__inner hero__inner--post">
            <Link className="chip" to="/blog">
              ‹ Back to blog
            </Link>
            <h1 className="display">{post.title}</h1>
            <p>{post.description}</p>
          </div>
        </div>
      </header>
      <Hr />
      <div className="col">
        <div className="post">
          <aside className="post__side">
            <div className="post__facts">
              <div className="post__fact">
                <span className="label">Author</span>
                <span>{post.author}</span>
              </div>
              <div className="post__fact">
                <span className="label">Published</span>
                <time dateTime={post.date}>{post.dateLabel}</time>
              </div>
              {post.headings.length > 0 ? (
                <nav className="post__fact" aria-label="Table of contents">
                  <span className="label">Table of contents</span>
                  <BlogToc headings={post.headings} />
                </nav>
              ) : null}
              <div className="post__fact">
                <span className="label">Share</span>
                <div className="post__share">
                  {shareLinks(post).map((link) => (
                    <a key={link.label} href={link.href} target="_blank" rel="noopener noreferrer">
                      {link.label} ↗
                    </a>
                  ))}
                </div>
              </div>
            </div>
          </aside>
          <article className="post__body">
            <BlogCover slug={post.slug} title={post.title} image={post.cover} />
            <div className="post__content prose-content">
              <RuntimeMdxContent document={post.document} components={proseComponents} />
            </div>
          </article>
        </div>
      </div>
      <Band spec={BANDS.beforeFooter} />
      <SiteFooter />
    </MarketingPage>
  )
}
