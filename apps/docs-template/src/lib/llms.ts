/**
 * Content of `/llms.txt` (page index) and `/llms-full.txt` (full corpus),
 * the llms.txt convention (https://llmstxt.org/) for external AI tools.
 *
 * Both read the requesting site's published pages through its runtime
 * source, in navigation order, so a site only ever lists its own content.
 */
import type { DocsRequestContext } from "@/src/runtime/request-context";
import {
  normalizeRuntimeHref,
  type DoxaDocsRuntimeSource,
  type RuntimeSection,
} from "@/src/runtime/runtime-source";
import { isNoPublishedDocsError } from "@/src/runtime/runtime-source-error";
import { createConfiguredRuntimeSource } from "@/src/runtime/runtime-source-selection";
import { loadSiteConfig } from "@/src/site-config/load-site-config";
import { readFrontmatter } from "@doxahq/mdx-runtime";
import type { ResolvedSiteConfig } from "@doxahq/site-config";

import { noPublishedDocsResponse } from "@/src/lib/no-published-docs";

export interface LlmsDocument {
  title: string;
  url: string;
  description: string;
  /** The page's MDX without its frontmatter. */
  content: string;
}

export interface LlmsSection {
  label: string;
  documents: LlmsDocument[];
}

export interface LlmsSite {
  name: string;
  description: string;
  sections: LlmsSection[];
}

/** Pages read from the runtime at the same time. */
const PAGE_READ_CONCURRENCY = 8;

/**
 * The visible sections of a site with their pages. A page listed in more
 * than one section appears only in the first; a page without content is
 * left out.
 */
export async function loadLlmsSections(
  source: DoxaDocsRuntimeSource,
  origin: string
): Promise<LlmsSection[]> {
  const sections = (await source.getSections()).filter(
    (section) => !section.hidden
  );
  const hrefsBySection = await listSectionHrefs(source, sections);
  const allHrefs = hrefsBySection.flat();
  const documents = await mapWithConcurrency(
    allHrefs,
    PAGE_READ_CONCURRENCY,
    (href) => loadLlmsDocument(source, href, origin)
  );
  const documentByHref = new Map(
    allHrefs.map((href, index) => [href, documents[index]])
  );

  return sections.map((section, index) => ({
    label: section.label,
    documents: hrefsBySection[index].flatMap((href) => {
      const document = documentByHref.get(href);
      return document ? [document] : [];
    }),
  }));
}

async function listSectionHrefs(
  source: DoxaDocsRuntimeSource,
  sections: readonly RuntimeSection[]
): Promise<string[][]> {
  const routes = await Promise.all(
    sections.map((section) => source.getRoutes(section.slug))
  );
  const seen = new Set<string>();
  return routes.map((sectionRoutes) =>
    sectionRoutes.flatMap((route) => {
      const href = normalizeRuntimeHref(route.href);
      if (seen.has(href)) return [];
      seen.add(href);
      return [href];
    })
  );
}

async function loadLlmsDocument(
  source: DoxaDocsRuntimeSource,
  href: string,
  origin: string
): Promise<LlmsDocument | null> {
  const page = await source.getRawPage(href);
  if (!page) return null;
  return {
    title: page.title || page.href,
    url: `${origin}${normalizeRuntimeHref(page.href)}`,
    description: page.description,
    content: readFrontmatter(page.body).content.trim(),
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  map: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await map(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
  return results;
}

function siteHeader(site: LlmsSite): string[] {
  return [`# ${site.name}`, "", `> ${site.description}`, ""];
}

/** Sections with pages. One section is not named, as in a site without sections. */
function listedSections(site: LlmsSite): {
  grouped: boolean;
  sections: LlmsSection[];
} {
  const sections = site.sections.filter(
    (section) => section.documents.length > 0
  );
  return { grouped: site.sections.length > 1, sections };
}

function formatIndexEntry(document: LlmsDocument): string {
  const description = document.description ? `: ${document.description}` : "";
  return `- [${document.title}](${document.url})${description}`;
}

/** `/llms.txt`: the site name and description, then a link per page. */
export function formatLlmsIndex(site: LlmsSite): string {
  const lines = siteHeader(site);
  const { grouped, sections } = listedSections(site);

  if (!grouped) {
    lines.push("## Docs", "");
    for (const section of sections) {
      lines.push(...section.documents.map(formatIndexEntry));
    }
    return lines.join("\n");
  }

  for (const section of sections) {
    lines.push(`## ${section.label}`, "");
    lines.push(...section.documents.map(formatIndexEntry));
    lines.push("");
  }
  return lines.join("\n");
}

/** `/llms-full.txt`: every page's content, each with its source URL. */
export function formatLlmsFull(site: LlmsSite): string {
  const lines = siteHeader(site);
  const { grouped, sections } = listedSections(site);

  for (const section of sections) {
    if (grouped) lines.push(`# ${section.label}`, "");
    for (const document of section.documents) {
      lines.push(
        "---",
        "",
        `## ${document.title}`,
        `Source: ${document.url}`,
        "",
        document.content,
        ""
      );
    }
  }
  return lines.join("\n");
}

const LLMS_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "public, max-age=3600",
} as const;

/**
 * The response of an llms route for the requesting site. A host without
 * published docs gets a 404.
 */
export async function createLlmsResponse(
  request: Request,
  context: DocsRequestContext | undefined,
  format: (site: LlmsSite) => string
): Promise<Response> {
  try {
    const source =
      context?.runtimeSource ?? (await createConfiguredRuntimeSource());
    const origin = new URL(request.url).origin;
    const [config, sections] = await Promise.all([
      context?.siteConfig ?? loadSiteConfig(source),
      loadLlmsSections(source, origin),
    ]);
    return new Response(format(toLlmsSite(config, sections)), {
      headers: LLMS_HEADERS,
    });
  } catch (error) {
    if (isNoPublishedDocsError(error)) return noPublishedDocsResponse(request);
    throw error;
  }
}

function toLlmsSite(
  config: ResolvedSiteConfig,
  sections: LlmsSection[]
): LlmsSite {
  return { name: config.name, description: config.description, sections };
}
