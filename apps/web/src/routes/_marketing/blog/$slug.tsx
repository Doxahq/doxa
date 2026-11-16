import { createFileRoute, notFound } from "@tanstack/react-router"
import { BlogPostPage } from "~/components/marketing/blog/blog-post-page"
import { blogPostHead } from "~/lib/marketing/blog-seo"
import { getBlogPost } from "~/server/blog"

export const Route = createFileRoute("/_marketing/blog/$slug")({
  loader: async ({ params }) => {
    const post = await getBlogPost({ data: params.slug })
    if (!post) throw notFound()
    return post
  },
  head: ({ loaderData }) => (loaderData ? blogPostHead(loaderData) : {}),
  // A post changes only with a release. The contents list changes the hash, which must not load it again.
  staleTime: Number.POSITIVE_INFINITY,
  component: BlogPostRoute,
})

function BlogPostRoute() {
  return <BlogPostPage post={Route.useLoaderData()} />
}
