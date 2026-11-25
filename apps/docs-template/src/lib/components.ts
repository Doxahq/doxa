import {
  createProseComponents,
  ProseTable,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type ProseElementMap,
} from "@doxahq/docs-prose";

import Pre from "@/src/components/ui/pre";
import { ExternalLinkIcon, resolveDocsIcon } from "@/src/components/docs-icon";
import {
  ApiEndpoint,
  ApiParam,
  ApiParams,
  ApiRequestExample,
  ApiResponseExample,
} from "@/src/components/markdown/api-endpoint";
import { File, FileTree, Folder } from "@/src/components/markdown/filetree";
import RoutedLink from "@/src/components/markdown/link";
import Mermaid from "@/src/components/markdown/mermaid/index";
import { ZoomableImage } from "@/src/components/markdown/zoomable-image";

/**
 * MDX component registry for the published docs.
 *
 * Notes, cards, steps, tabs, and the code fence and diagram markup come from
 * `@doxahq/docs-prose`, so the dashboard editor renders them identically.
 * Everything this app supplies itself is wired here: routing, icons, the lazy
 * file tree, the lazy diagram loader, and the API reference blocks.
 */
export const components = createProseComponents({
  link: RoutedLink,
  resolveIcon: resolveDocsIcon,
  externalIcon: ExternalLinkIcon,
  overrides: {
    ApiEndpoint,
    ApiParam,
    ApiParams,
    ApiRequestExample,
    ApiResponseExample,
    File,
    FileTree,
    Folder,
    Mermaid,
    pre: Pre,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
  },
});

/**
 * Plain HTML elements that the published docs draw with their own component.
 * A page image opens in a full-screen viewer with zoom.
 */
export const elements: ProseElementMap = {
  img: ZoomableImage,
  table: ProseTable,
};
