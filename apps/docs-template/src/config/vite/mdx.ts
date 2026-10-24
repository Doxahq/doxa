import {
  getDocsCodeBlockTransformers,
  getDocsHighlighter,
} from "@doxahq/mdx-runtime/highlight";
import mdx from "@mdx-js/rollup";
import rehypeShikiFromHighlighter from "@shikijs/rehype/core";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeCodeTitles from "rehype-code-titles";
import rehypeKatex from "rehype-katex";
import rehypeSlug from "rehype-slug";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";

import { rehypePreCopy, remarkStripFrontmatter } from "../../lib/mdx-plugins";

export function createMdxPlugin() {
  return mdx({
    remarkPlugins: [remarkFrontmatter, remarkStripFrontmatter, remarkGfm],
    rehypePlugins: [
      rehypePreCopy,
      rehypeCodeTitles,
      rehypeKatex,
      [
        rehypeShikiFromHighlighter,
        getDocsHighlighter(),
        {
          themes: { light: "github-light", dark: "github-dark" },
          defaultColor: false,
          transformers: getDocsCodeBlockTransformers(),
        },
      ],
      rehypeSlug,
      rehypeAutolinkHeadings,
    ],
  });
}
