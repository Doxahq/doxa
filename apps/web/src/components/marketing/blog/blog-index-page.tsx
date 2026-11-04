import { Link } from "@tanstack/react-router"
import { Band } from "~/components/marketing/band"
import { BlogCover } from "~/components/marketing/blog/blog-cover"
import { Hr } from "~/components/marketing/guides"
import { MarketingPage } from "~/components/marketing/marketing-page"
import { SiteFooter } from "~/components/marketing/site-footer"
import { SiteNav } from "~/components/marketing/site-nav"
import { BANDS } from "~/lib/marketing/bands"
import type { BlogPostMeta } from "~/lib/marketing/blog"

export const BLOG_SUMMARY = "How we build Doxa, and what we learn about keeping documentation true to the code."

/** The blog list: a short hero and one card per post, newest first. */
export function BlogIndexPage({ posts }: { posts: BlogPostMeta[] }) {
  return (
    <MarketingPage page="blog">
      <header className="hero">
        <div className="hero__glow" aria-hidden="true" />
        <SiteNav current="blog" />
        <Hr />
        <div className="col">
          <div className="hero__inner">
            <span className="chip">Blog</span>
            <h1 className="display">Notes on docs that stay true</h1>
            <p>{BLOG_SUMMARY}</p>
          </div>
        </div>
      </header>
      <Hr />
      <div className="col">
        <div className="posts">
          {posts.map((post) => (
            <Link className="post-card" to="/blog/$slug" params={{ slug: post.slug }} key={post.slug}>
              <BlogCover slug={post.slug} title={post.title} image={post.cover} />
              <div className="post-card__text">
                <h2>{post.title}</h2>
                <p className="post-card__meta">
                  <span>{post.author}</span>
                  <time dateTime={post.date}>{post.dateLabel}</time>
                </p>
              </div>
            </Link>
          ))}
        </div>
      </div>
      <Band spec={BANDS.beforeFooter} />
      <SiteFooter />
    </MarketingPage>
  )
}
