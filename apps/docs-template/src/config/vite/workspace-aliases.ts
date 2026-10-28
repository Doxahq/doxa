import { fileURLToPath } from "node:url";

import type { Alias } from "vite";

const MDX_RUNTIME_SOURCE = new URL(
  "../../../../../packages/mdx-runtime/src/",
  import.meta.url
);

function mdxRuntimeSource(path: string): string {
  return fileURLToPath(new URL(path, MDX_RUNTIME_SOURCE));
}

/**
 * Points every `@doxahq/mdx-runtime` import at the package source, the way
 * the template's own tsconfig paths do.
 *
 * Without it, an import from another workspace package (such as
 * `@doxahq/docs-prose`) resolves to the package's built `dist` files instead.
 * The bundle then holds two copies of the parser and two Shiki highlighters,
 * each with its own cache.
 *
 * The patterns match whole specifiers, so the bare package name does not
 * capture its subpaths.
 */
export const workspaceSourceAliases: Alias[] = [
  {
    find: /^@doxahq\/mdx-runtime$/,
    replacement: mdxRuntimeSource("index.ts"),
  },
  {
    find: /^@doxahq\/mdx-runtime\/highlight$/,
    replacement: mdxRuntimeSource("highlight/index.ts"),
  },
  {
    find: /^@doxahq\/mdx-runtime\/highlight-lazy$/,
    replacement: mdxRuntimeSource("highlight/lazy.ts"),
  },
];
