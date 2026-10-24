import {
  isRuntimeMdxComponentName,
  type RuntimeMdxElementNode,
  type RuntimeMdxNode,
} from "@doxahq/mdx-runtime";

/**
 * Node normalization applied before a document is rendered.
 *
 * MDX puts block components inside a paragraph when the author writes them
 * without blank lines around them, which is how most people write them:
 *
 *     <Step>
 *     <StepItem title="Install">Add the package.</StepItem>
 *     <StepItem title="Run">Run the client.</StepItem>
 *     </Step>
 *
 * Both `StepItem` nodes arrive as children of one paragraph. Rendering that
 * paragraph is wrong twice over: a `<div>` inside a `<p>` is invalid HTML, and
 * a parent that counts its children sees one child instead of two, so `<Step>`
 * numbers every item as step one.
 */

/** True when a paragraph holds only block components and whitespace. */
export function isComponentOnlyParagraph(node: RuntimeMdxElementNode): boolean {
  if (node.name !== "p" || !node.children?.length) return false;

  let hasComponent = false;
  for (const child of node.children) {
    if (child.type === "text") {
      // Real text means the components are inline in a sentence. Keep the
      // paragraph: unwrapping would drop the words around them.
      if (child.value.trim()) return false;
      continue;
    }
    // A link is inline by nature and never carries block content.
    if (!isRuntimeMdxComponentName(child.name) || child.name === "a") return false;
    hasComponent = true;
  }

  return hasComponent;
}

/**
 * The children to render in place of a component-only paragraph.
 *
 * Whitespace between the components is source layout only. Dropping it keeps
 * the rendered child count equal to the number of components.
 */
export function unwrapComponentParagraph(
  node: RuntimeMdxElementNode,
): RuntimeMdxNode[] {
  return (node.children ?? []).filter((child) => child.type !== "text");
}
