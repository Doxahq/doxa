import React from "react";
import {
  RuntimeMdxContent as SharedRuntimeMdxContent,
  type ProseComponentMap,
  type ProseElementMap,
} from "@doxahq/docs-prose";
import {
  isRuntimeMdxComponentName,
  RUNTIME_MDX_COMPONENT_NAMES,
  type RuntimeMdxDocument,
} from "@doxahq/mdx-runtime";

import { runtimeComponents } from "./mdx-components";

export {
  isRuntimeMdxComponentName,
  RUNTIME_MDX_COMPONENT_NAMES as runtimeMdxComponentNames,
};
export type {
  RuntimeMdxComponentName,
  RuntimeMdxDocument,
  RuntimeMdxElementName,
  RuntimeMdxElementNode,
  RuntimeMdxFrontmatter,
  RuntimeMdxIntrinsicName,
  RuntimeMdxNode,
  RuntimeMdxPropValue,
  RuntimeMdxTextNode,
} from "@doxahq/mdx-runtime";

export type RuntimeMdxComponentMap = ProseComponentMap;

/**
 * Renders a parsed MDX document with the docs component registry.
 *
 * The node walk lives in `@doxahq/docs-prose` so the dashboard content preview
 * renders pages exactly the same way. This wrapper only supplies the default
 * component set, which stays app-local because it carries routing and icons.
 */
export function RuntimeMdxContent({
  document,
  components,
  elements,
}: {
  document: RuntimeMdxDocument;
  components?: RuntimeMdxComponentMap;
  /** Replacements for plain HTML elements, such as the zoomable page image. */
  elements?: ProseElementMap;
}) {
  return React.createElement(SharedRuntimeMdxContent, {
    document,
    components: { ...runtimeComponents, ...components },
    ...(elements ? { elements } : {}),
  });
}
