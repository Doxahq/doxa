import { createElement, Fragment, type ElementType, type ReactNode } from "react";
import {
  isRuntimeMdxComponentName,
  type RuntimeMdxComponentMap as RuntimeMdxComponentMapBase,
  type RuntimeMdxDocument,
  type RuntimeMdxElementName,
  type RuntimeMdxElementNode,
  type RuntimeMdxIntrinsicName,
  type RuntimeMdxNode,
} from "@doxahq/mdx-runtime";

import { safeMdxProps } from "./mdx-prop-safety";
import { isComponentOnlyParagraph, unwrapComponentParagraph } from "./normalize";

export type ProseComponentMap = RuntimeMdxComponentMapBase<ElementType>;

/**
 * Replacements for plain HTML elements. The dashboard draws `img` through
 * one that loads an unpublished image with the user's session.
 */
export type ProseElementMap = Partial<
  Record<RuntimeMdxIntrinsicName, ElementType>
>;

interface RenderContext {
  components: ProseComponentMap;
  fallbackComponent: ElementType | undefined;
  elements: ProseElementMap | undefined;
}

export interface RuntimeMdxContentProps {
  document: RuntimeMdxDocument;
  components: ProseComponentMap;
  /**
   * Rendered in place of a component the map does not carry. Without it, an
   * unknown component name throws, which is right for a build-time renderer and
   * wrong for a live editor preview.
   */
  fallbackComponent?: ElementType;
  /** Replacements for plain HTML elements. The published site passes none. */
  elements?: ProseElementMap;
}

/**
 * Renders a parsed MDX document.
 *
 * This is the single node walk shared by the published docs renderer and the
 * dashboard content preview. Both pass their own component map, so the
 * structure of a page is identical in both and only the components differ.
 */
export function RuntimeMdxContent({
  document,
  components,
  fallbackComponent,
  elements,
}: RuntimeMdxContentProps) {
  return createElement(
    Fragment,
    null,
    ...renderNodes(document.nodes, { components, fallbackComponent, elements }),
  );
}

function renderNodes(
  nodes: readonly RuntimeMdxNode[],
  context: RenderContext,
  keyPrefix = "mdx",
): ReactNode[] {
  return nodes.map((node, index) =>
    renderNode(node, context, `${keyPrefix}-${index}`),
  );
}

function renderNode(
  node: RuntimeMdxNode,
  context: RenderContext,
  key: string,
): ReactNode {
  if (node.type === "text") return node.value;

  // Return the array rather than a fragment: `Children.toArray` flattens a
  // nested array but counts a fragment as one child, and `<Step>` numbers its
  // items by counting children. See `normalize.ts`.
  if (isComponentOnlyParagraph(node)) {
    return renderNodes(unwrapComponentParagraph(node), context, key);
  }

  return createElement(
    resolveElement(node.name, context),
    { key, ...safeMdxProps(node.props) },
    ...renderNodes(node.children ?? [], context, key),
  );
}

function resolveElement(
  name: RuntimeMdxElementName,
  { components, fallbackComponent, elements }: RenderContext,
): ElementType {
  if (!isRuntimeMdxComponentName(name)) return elements?.[name] ?? name;

  const component = components[name] ?? fallbackComponent;
  if (!component) throw new Error(`Unknown MDX component: ${name}`);
  return component;
}

export type { RuntimeMdxDocument, RuntimeMdxElementNode, RuntimeMdxNode };
