import { createFileRoute } from "@tanstack/react-router"
import { BLOG_SUMMARY, BlogIndexPage } from "~/components/marketing/blog/blog-index-page"
import { getBlogPosts } from "~/server/blog"

export const Route = createFileRoute("/_marketing/blog/")({
  head: () => ({
    meta: [{ title: "Blog — Doxa" }, { name: "description", content: BLOG_SUMMARY }],
  }),
  loader: () => getBlogPosts(),
  staleTime: Number.POSITIVE_INFINITY,
  component: BlogIndexRoute,
})

function BlogIndexRoute() {
  return <BlogIndexPage posts={Route.useLoaderData()} />
}
