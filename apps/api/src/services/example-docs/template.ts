import type {
  RuntimeDocsNavigationInput,
  RuntimeDocsPageInput,
} from "@doxahq/docs-engine";
import { EXAMPLE_DOCS_PAGE_SOURCES } from "./pages.generated";

interface ExampleDocsPage {
  title: string;
  route: string;
  navigationPath: string;
  file: string;
}

const PROJECT_NAME_TOKEN = '"{{projectName}}"';

const EXAMPLE_DOCS_PAGES: readonly ExampleDocsPage[] = [
  { title: "Introduction", route: "/", navigationPath: "introduction/index.mdx", file: "introduction.mdx" },
  { title: "Quickstart", route: "/quickstart", navigationPath: "quickstart/index.mdx", file: "quickstart.mdx" },
  { title: "Text and formatting", route: "/writing/formatting", navigationPath: "writing/formatting/index.mdx", file: "formatting.mdx" },
  { title: "Code blocks", route: "/writing/code-blocks", navigationPath: "writing/code-blocks/index.mdx", file: "code-blocks.mdx" },
  { title: "Callouts and cards", route: "/writing/components", navigationPath: "writing/components/index.mdx", file: "components.mdx" },
  { title: "Diagrams and file trees", route: "/writing/diagrams", navigationPath: "writing/diagrams/index.mdx", file: "diagrams.mdx" },
  { title: "Navigation and sections", route: "/publishing/navigation", navigationPath: "publishing/navigation/index.mdx", file: "navigation.mdx" },
  { title: "Publish and connect GitHub", route: "/publishing/publish", navigationPath: "publishing/publish/index.mdx", file: "publish.mdx" },
  { title: "API overview", route: "/api", navigationPath: "api/index.mdx", file: "api-overview.mdx" },
  { title: "Create a note", route: "/api/notes/create", navigationPath: "api/notes/create/index.mdx", file: "api-create-note.mdx" },
];

export const EXAMPLE_DOCS_NAVIGATION: RuntimeDocsNavigationInput = {
  sections: [
    {
      slug: "default",
      items: [],
      groups: [
        {
          heading: "Get Started",
          items: ["introduction/index.mdx", "quickstart/index.mdx"],
        },
        {
          heading: "Writing Content",
          items: [
            "writing/formatting/index.mdx",
            "writing/code-blocks/index.mdx",
            "writing/components/index.mdx",
            "writing/diagrams/index.mdx",
          ],
        },
        {
          heading: "Publishing",
          items: [
            "publishing/navigation/index.mdx",
            "publishing/publish/index.mdx",
          ],
        },
      ],
    },
    {
      slug: "api",
      items: ["api/index.mdx"],
      groups: [{ heading: "Notes", items: ["api/notes/create/index.mdx"] }],
    },
  ],
  icons: {
    "introduction/index.mdx": "book",
    "quickstart/index.mdx": "rocket",
    "api/index.mdx": "server",
  },
  navTitles: { "introduction/index.mdx": "Introduction" },
  navBadges: { "writing/diagrams/index.mdx": "New" },
  sectionMetadata: {
    default: { label: "Documentation", kind: "documentation", layout: "docs" },
    api: { label: "API Reference", kind: "reference", layout: "reference" },
  },
};

/** The example pages, with the project name written into the home page. */
export function createExampleDocsPages(
  projectName: string,
): RuntimeDocsPageInput[] {
  return EXAMPLE_DOCS_PAGES.map((page) => {
    const source = EXAMPLE_DOCS_PAGE_SOURCES[page.file];
    if (source === undefined) {
      throw new Error(`Example docs page ${page.file} is missing.`);
    }
    // A JSON string is a valid YAML double-quoted scalar, so any name is safe.
    const content = source.replace(
      PROJECT_NAME_TOKEN,
      JSON.stringify(projectName),
    );
    return {
      title: page.route === "/" ? projectName : page.title,
      route: page.route,
      navigationPath: page.navigationPath,
      content,
    };
  });
}
