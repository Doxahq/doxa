/**
 * Shared prose rendering for Doxa documentation pages.
 *
 * One MDX node walk, one prose component set, one article typography class,
 * used by both the published docs renderer (`apps/docs-template`) and the
 * dashboard content preview (`apps/web`). A page therefore looks the same in
 * the editor as it does once it is published.
 *
 * Host-specific pieces — routing, icons, syntax highlighting, interactive
 * components, API reference blocks — are injected. Nothing in this package
 * imports from an application.
 *
 * The stylesheet ships alongside: `@doxahq/docs-prose/styles.css`.
 */

export { ARTICLE_PROSE_CLASS } from "./article";

export {
  activeTocIndex,
  tocScrollTargets,
  tocTriggers,
  type TocScrollMetrics,
} from "./toc-spy";

export { loadProseHighlighter, type ProseHighlighter } from "./highlight";

export {
  DOCS_ICON_NAMES,
  isDocsIconName,
  type DocsIconName,
} from "./icon-names";

export {
  coreIconNode,
  CORE_ICON_NODES,
  DOCS_ICON_NAME_PATTERN,
  DocsIconSvg,
  docsIconKey,
  docsIconLabel,
  LUCIDE_ICON_COUNT,
  type DocsIconNode,
  type DocsIconSvgProps,
} from "./icons";

export {
  RuntimeMdxContent,
  type ProseComponentMap,
  type ProseElementMap,
  type RuntimeMdxContentProps,
} from "./render/runtime-mdx-content";

export {
  isComponentOnlyParagraph,
  unwrapComponentParagraph,
} from "./render/normalize";

export { createProseComponents, type CreateProseComponentsOptions } from "./components/registry";

export { ProseLink, type ProseLinkComponent, type ProseLinkProps } from "./components/link";
export { Embed, type EmbedProps } from "./components/embed";
export { Note, type NoteProps, type NoteVariant } from "./components/note";
export {
  Step,
  StepFrame,
  StepItem,
  StepList,
  type StepFrameProps,
  type StepItemProps,
  type StepProps,
} from "./components/step";
export {
  createFileTree,
  type FileProps,
  type FileTreeComponents,
  type FileTreeIcons,
  type FileTreeProps,
  type FolderProps,
} from "./components/file-tree";
export {
  Card,
  CardGrid,
  createCard,
  type CardDependencies,
  type CardProps,
  type CardVariant,
  type IconComponent,
  type IconResolver,
} from "./components/card";
export { createPre, type PreIcons, type PreProps } from "./components/pre";
export { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/tabs";
export { createMermaid, type MermaidApi, type MermaidProps } from "./components/mermaid";
