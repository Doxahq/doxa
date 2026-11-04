import { describe, expect, it } from "vitest"

import { formatBlogDate, isDraftPost, listBlogPosts, loadBlogPost } from "~/lib/marketing/blog"

describe("blog posts", () => {
  it("formats the calendar date without timezone drift", () => {
    expect(formatBlogDate("2026-11-02")).toBe("November 2, 2026")
    expect(formatBlogDate("2026-01-01")).toBe("January 1, 2026")
  })

  it("treats only a frontmatter `draft: true` as a draft", () => {
    expect(isDraftPost('---\ntitle: "A"\ndraft: true\n---\nBody')).toBe(true)
    expect(isDraftPost('---\ntitle: "A"\n---\nBody')).toBe(false)
    expect(isDraftPost('---\ndraft: false\n---\nBody')).toBe(false)
    expect(isDraftPost('---\ntitle: "A"\n---\ndraft: true')).toBe(false)
  })

  it("lists every post with its frontmatter, newest first", () => {
    const posts = listBlogPosts()
    expect(posts.length).toBeGreaterThan(0)
    for (const post of posts) {
      expect(post.title && post.description && post.author && post.slug).toBeTruthy()
      expect(post.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    const dates = posts.map((post) => post.date)
    expect(dates).toEqual([...dates].sort().reverse())
  })

  it("loads a post with its headings and returns null for an unknown slug", async () => {
    const [first] = listBlogPosts()
    const post = await loadBlogPost(first.slug)
    expect(post?.title).toBe(first.title)
    expect(post?.document.nodes.length).toBeGreaterThan(0)
    expect(post?.headings.every((heading) => heading.level === 2 || heading.level === 3)).toBe(true)
    await expect(loadBlogPost("no-such-post")).resolves.toBeNull()
  })
})
