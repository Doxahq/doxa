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
import { utf8ByteLength } from "@/src/lib/utf8";

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
  /** True when pages were left out to stay within the size limit. */
  truncated?: boolean;
}

export interface LlmsLoadOptions {
  /** False leaves page content out, for the page index. Defaults to true. */
  includeContent?: boolean;
  /**
   * Stop reading pages once their content reaches this many bytes. One
   * renderer isolate serves many sites, so the corpus must stay bounded.
   */
  contentByteBudget?: number;
  /**
   * What happens to a page once the budget is spent: "skip" leaves it out
   * (the corpus is truncated); "nav-title" lists it with its navigation
   * title and no description, without reading it. Defaults to "skip".
   */
  pastBudget?: "skip" | "nav-title";
}

export interface LlmsCorpus {
  sections: LlmsSection[];
  truncated: boolean;
}

/** Pages read from the runtime at the same time. */
const PAGE_READ_CONCURRENCY = 8;

/** Largest `/llms-full.txt`, in bytes. Pages after it are left out. */
export const LLMS_FULL_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Page bytes `/llms.txt` reads for titles and descriptions. Pages after it
 * are listed with their navigation title, so the index still lists every
 * page but one request never reads an unbounded corpus.
 */
export const LLMS_INDEX_READ_BYTE_BUDGET = 2 * 1024 * 1024;

export const LLMS_INDEX_LOAD_OPTIONS: LlmsLoadOptions = {
  includeContent: false,
  contentByteBudget: LLMS_INDEX_READ_BYTE_BUDGET,
  pastBudget: "nav-title",
};

export const LLMS_FULL_LOAD_OPTIONS: LlmsLoadOptions = {
  contentByteBudget: LLMS_FULL_MAX_BYTES,
};

const LLMS_FULL_TRUNCATION_NOTE =
  "> This file stops at its 5 MB limit, so some pages are left out. /llms.txt lists every page.";

/**
 * The visible sections of a site with their pages. A page listed in more
 * than one section appears only in the first; a page without content is
 * left out.
 */
export async function loadLlmsSections(
  source: DoxaDocsRuntimeSource,
  origin: string,
  options: LlmsLoadOptions = {}
): Promise<LlmsSection[]> {
  return (await loadLlmsCorpus(source, origin, options)).sections;
}

/** Like `loadLlmsSections`, and says whether the byte budget cut pages. */
export async function loadLlmsCorpus(
  source: DoxaDocsRuntimeSource,
  origin: string,
  {
    includeContent = true,
    contentByteBudget,
    pastBudget = "skip",
  }: LlmsLoadOptions = {}
): Promise<LlmsCorpus> {
  const sections = (await source.getSections()).filter(
    (section) => !section.hidden
  );
  const routesBySection = await listSectionRoutes(source, sections);
  const allRoutes = routesBySection.flat();
  const budget = createByteBudget(contentByteBudget);
  const documents = await mapWithConcurrency(
    allRoutes,
    PAGE_READ_CONCURRENCY,
    async (route) => {
      if (budget.exhausted()) {
        if (pastBudget === "nav-title") return navTitleDocument(route, origin);
        budget.markSkipped();
        return null;
      }
      const document = await loadLlmsDocument(source, route.href, origin);
      if (!document) return null;
      budget.spend(utf8ByteLength(document.content));
      return includeContent ? document : { ...document, content: "" };
    }
  );
  const documentByHref = new Map(
    allRoutes.map((route, index) => [route.href, documents[index]])
  );

  return {
    truncated: budget.skipped(),
    sections: sections.map((section, index) => ({
      label: section.label,
      documents: routesBySection[index].flatMap((route) => {
        const document = documentByHref.get(route.href);
        return document ? [document] : [];
      }),
    })),
  };
}

interface LlmsRoute {
  href: string;
  title: string;
}

function navTitleDocument(route: LlmsRoute, origin: string): LlmsDocument {
  return {
    title: route.title || route.href,
    url: `${origin}${route.href}`,
    description: "",
    content: "",
  };
}

/**
 * A spend limit. Reaching it exactly is not a truncation: only a page
 * actually left out marks the corpus as truncated.
 */
function createByteBudget(limit: number | undefined) {
  let spent = 0;
  let skipped = false;
  return {
    exhausted: () => limit !== undefined && spent >= limit,
    spend(bytes: number) {
      spent += bytes;
    },
    markSkipped() {
      skipped = true;
    },
    skipped: () => skipped,
  };
}

async function listSectionRoutes(
  source: DoxaDocsRuntimeSource,
  sections: readonly RuntimeSection[]
): Promise<LlmsRoute[][]> {
  const routes = await Promise.all(
    sections.map((section) => source.getRoutes(section.slug))
  );
  const seen = new Set<string>();
  return routes.map((sectionRoutes) =>
    sectionRoutes.flatMap((route) => {
      const href = normalizeRuntimeHref(route.href);
      if (seen.has(href)) return [];
      seen.add(href);
      return [{ href, title: route.title }];
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

/**
 * `/llms-full.txt`: every page's content, each with its source URL. Stops
 * before `maxBytes`, with a note that pages are left out.
 */
export function formatLlmsFull(
  site: LlmsSite,
  maxBytes: number = LLMS_FULL_MAX_BYTES
): string {
  const lines = siteHeader(site);
  const { grouped, sections } = listedSections(site);
  const noteBytes = utf8ByteLength(LLMS_FULL_TRUNCATION_NOTE) + 2;
  let bytes = utf8ByteLength(lines.join("\n")) + 1;
  // The loader's flag only adds the note: the pages it did read are printed.
  let truncated = false;

  const append = (block: string[]): boolean => {
    const blockBytes = utf8ByteLength(block.join("\n")) + 1;
    if (bytes + blockBytes + noteBytes > maxBytes) return false;
    lines.push(...block);
    bytes += blockBytes;
    return true;
  };

  for (const section of sections) {
    if (truncated) break;
    if (grouped && !append([`# ${section.label}`, ""])) {
      truncated = true;
      break;
    }
    for (const document of section.documents) {
      const block = [
        "---",
        "",
        `## ${document.title}`,
        `Source: ${document.url}`,
        "",
        document.content,
        "",
      ];
      if (!append(block)) {
        truncated = true;
        break;
      }
    }
  }
  if (truncated || site.truncated) lines.push(LLMS_FULL_TRUNCATION_NOTE, "");
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
  format: (site: LlmsSite) => string,
  options: LlmsLoadOptions = {}
): Promise<Response> {
  try {
    const source =
      context?.runtimeSource ?? (await createConfiguredRuntimeSource());
    const origin = new URL(request.url).origin;
    const [config, corpus] = await Promise.all([
      context?.siteConfig ?? loadSiteConfig(source),
      loadLlmsCorpus(source, origin, options),
    ]);
    return new Response(format(toLlmsSite(config, corpus)), {
      headers: LLMS_HEADERS,
    });
  } catch (error) {
    if (isNoPublishedDocsError(error)) return noPublishedDocsResponse(request);
    throw error;
  }
}

function toLlmsSite(config: ResolvedSiteConfig, corpus: LlmsCorpus): LlmsSite {
  return {
    name: config.name,
    description: config.description,
    sections: corpus.sections,
    ...(corpus.truncated ? { truncated: true } : {}),
  };
}
