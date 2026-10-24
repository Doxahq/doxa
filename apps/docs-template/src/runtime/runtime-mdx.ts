import React from "react";
import {
  parseRuntimeMdx,
  type RuntimeMdxFrontmatter,
  type RuntimeMdxParseOptions,
} from "@doxahq/mdx-runtime";
import { renderToString } from "react-dom/server";

import {
  RuntimeMdxContent,
  type RuntimeMdxComponentMap,
} from "./runtime-mdx-content";

export { parseRuntimeMdx } from "@doxahq/mdx-runtime";
export type {
  RuntimeMdxComponentName,
  RuntimeMdxDocument,
  RuntimeMdxNode,
  RuntimeMdxParseOptions,
} from "@doxahq/mdx-runtime";
export { RuntimeMdxContent } from "./runtime-mdx-content";
export type { RuntimeMdxComponentMap } from "./runtime-mdx-content";

export interface RuntimeMdxRenderOptions extends RuntimeMdxParseOptions {
  components?: RuntimeMdxComponentMap;
}

export interface RuntimeMdxRenderResult {
  html: string;
  frontmatter: RuntimeMdxFrontmatter;
}

export async function renderRuntimeMdx(
  source: string,
  options: RuntimeMdxRenderOptions = {}
): Promise<RuntimeMdxRenderResult> {
  const document = parseRuntimeMdx(source, options);

  return {
    html: renderToString(
      React.createElement(RuntimeMdxContent, {
        document,
        components: options.components,
      })
    ),
    frontmatter: document.frontmatter,
  };
}
