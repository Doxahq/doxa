import { createServerFn } from "@tanstack/react-start"

import { listBlogPosts, loadBlogPost } from "~/lib/marketing/blog"

/**
 * The blog runs on the server: a prerender writes the highlighted post into the
 * HTML, and moving between pages does not send the post sources or the
 * highlighter to the browser.
 */
export const getBlogPosts = createServerFn({ method: "GET" }).handler(async () => listBlogPosts())

export const getBlogPost = createServerFn({ method: "GET" })
  .validator((slug: string) => slug)
  .handler(async ({ data: slug }) => loadBlogPost(slug))
