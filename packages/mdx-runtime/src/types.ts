import type { HighlighterCore } from "shiki/core";

export const RUNTIME_MDX_COMPONENT_NAMES = [
  "a",
  "ApiEndpoint",
  "ApiParam",
  "ApiParams",
  "ApiRequestExample",
  "ApiResponseExample",
  "Card",
  "CardGrid",
  "Embed",
  "File",
  "FileTree",
  "Folder",
  "Mermaid",
  "Note",
  "Step",
  "StepItem",
  "Tabs",
  "TabsContent",
  "TabsList",
  "TabsTrigger",
  "pre",
] as const;

export const RUNTIME_MDX_INTRINSIC_NAMES = [
  "blockquote",
  "br",
  "code",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "li",
  "ol",
  "p",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
] as const;

const runtimeMdxComponentNameSet = new Set<string>(RUNTIME_MDX_COMPONENT_NAMES);

export type RuntimeMdxComponentName =
  (typeof RUNTIME_MDX_COMPONENT_NAMES)[number];

export type RuntimeMdxComponentMap<TComponent> = Partial<
  Record<RuntimeMdxComponentName, TComponent>
>;

export type RuntimeMdxPropValue =
  | string
  | number
  | boolean
  | Record<string, string>;

export type RuntimeMdxIntrinsicName =
  (typeof RUNTIME_MDX_INTRINSIC_NAMES)[number];

export type RuntimeMdxElementName =
  | RuntimeMdxIntrinsicName
  | RuntimeMdxComponentName;

export interface RuntimeMdxTextNode {
  type: "text";
  value: string;
}

export interface RuntimeMdxElementNode {
  type: "element";
  name: RuntimeMdxElementName;
  props?: Record<string, RuntimeMdxPropValue>;
  children?: RuntimeMdxNode[];
}

export type RuntimeMdxNode = RuntimeMdxTextNode | RuntimeMdxElementNode;

export interface RuntimeMdxFrontmatter {
  title?: string;
  description?: string;
  keywords?: string[];
  apiMethod?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  apiPath?: string;
}

export interface RuntimeMdxDocument {
  frontmatter: RuntimeMdxFrontmatter;
  nodes: RuntimeMdxNode[];
}

export interface RuntimeMdxParseOptions {
  sourceLabel?: string;
  highlighter?: Pick<HighlighterCore, "codeToHast">;
  /**
   * Maps a root-relative image URL, such as `/assets/diagram.png`, to the URL
   * the page uses. The docs renderer adds the content hash of the version so
   * the browser can keep the image for a year. Return the input unchanged
   * when nothing is known about the URL.
   */
  resolveAssetUrl?: (url: string) => string;
}

export interface RuntimeMdxCodeBlockOptions {
  language?: string;
  meta?: string;
  highlighter?: Pick<HighlighterCore, "codeToHast">;
}

export function isRuntimeMdxComponentName(
  name: string | null | undefined,
): name is RuntimeMdxComponentName {
  return Boolean(name && runtimeMdxComponentNameSet.has(name));
}
