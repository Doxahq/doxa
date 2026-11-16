import { createFileRoute } from "@tanstack/react-router"
import { BLOG_SUMMARY, BlogIndexPage } from "~/components/marketing/blog/blog-index-page"
import { getBlogPosts } from "~/server/blog"
import { marketingHead } from "~/lib/marketing/seo"

export const Route = createFileRoute("/_marketing/blog/")({
  head: () =>
    marketingHead({
      path: "/blog",
      title: "Blog — Doxa",
      description: `${BLOG_SUMMARY} Product news, guides and engineering notes from the Doxa team.`,
    }),
  loader: () => getBlogPosts(),
  staleTime: Number.POSITIVE_INFINITY,
  component: BlogIndexRoute,
})

function BlogIndexRoute() {
  return <BlogIndexPage posts={Route.useLoaderData()} />
}
