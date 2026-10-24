import type { McpServer } from "@modelcontextprotocol/server";
import { RUNTIME_MDX_COMPONENT_NAMES } from "@doxahq/mdx-runtime";
import {
  MDX_AUTHORING_RULES,
  MDX_COMPONENT_GUIDES,
  type MdxComponentGuide,
} from "./mdx-component-guide";

export const MDX_REFERENCE_URI = "doxa://reference/mdx";
const ONE_HOUR_MS = 3_600_000;

/** Lowercase names are Markdown elements the renderer maps, not components. */
export function authorableComponentNames(): string[] {
  return RUNTIME_MDX_COMPONENT_NAMES.filter((name) => /^[A-Z]/.test(name));
}

export function renderMdxReference(): string {
  return [
    "# Doxa MDX reference",
    "",
    "Pages are MDX. write_page and edit_docs reject a page that the renderer cannot parse.",
    "",
    "## Rules",
    "",
    ...MDX_AUTHORING_RULES.map((rule) => `- ${rule}`),
    "",
    "## Supported components",
    "",
    authorableComponentNames()
      .map((name) => `\`${name}\``)
      .join(", "),
    "",
    ...MDX_COMPONENT_GUIDES.flatMap(renderGuide),
  ].join("\n");
}

function renderGuide(guide: MdxComponentGuide): string[] {
  const names = guide.names.map((name) => `\`${name}\``).join(", ");
  const example = guide.example
    ? ["", "````mdx", guide.example, "````"]
    : [];
  return [
    `### ${guide.title} (${names})`,
    "",
    guide.use,
    "",
    ...guide.props.map((props) => `- ${props}`),
    ...example,
    "",
  ];
}

export function registerMdxReferenceResource(server: McpServer): void {
  server.registerResource(
    "mdx-reference",
    MDX_REFERENCE_URI,
    {
      title: "MDX reference",
      description:
        "The MDX components that Doxa pages can use, with their props and examples.",
      mimeType: "text/markdown",
      cacheHint: { cacheScope: "public", ttlMs: ONE_HOUR_MS },
    },
    (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/markdown", text: renderMdxReference() },
      ],
    }),
  );
}
