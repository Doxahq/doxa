/**
 * Typography for a documentation article body.
 *
 * The published docs route and the dashboard content preview both render page
 * content and must look identical. Keeping the class list here stops the two
 * from drifting apart. Change it in one place only.
 */
export const ARTICLE_PROSE_CLASS =
  "prose-code:font-code @container/article prose w-full max-w-3xl min-w-0 flex-1 prose-zinc dark:prose-invert prose-headings:scroll-m-20 prose-code:before:content-none prose-code:after:content-none prose-pre:border prose-pre:bg-muted/25 prose-img:rounded-md";
