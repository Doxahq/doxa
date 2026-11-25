import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  type ComponentType,
  type LazyExoticComponent,
} from "react";
import { useDemoMode } from "@/src/contexts/demo-mode";
import type {
  DocsRoutePageData,
  ParsedDocument,
} from "@/src/runtime/docs-route-data";
import { RuntimeMdxContent } from "@/src/runtime/runtime-mdx-content";
import { loadDocsRawPage } from "@/src/runtime/runtime-route-data";
import { useSiteConfig } from "@/src/site-config/site-config-context";
import { docsLayout } from "@doxahq/site-config";

import { isChatAvailable } from "@/src/lib/chat-availability";
import type { ChatPageContext } from "@/src/lib/chat-page-context";
import { components, elements } from "@/src/lib/components";
import { cn } from "@/src/lib/utils";
import { ArticleEnd } from "@/src/components/article/article-end";
import { ArticleTitle } from "@/src/components/article/article-title";
import { ChatWithPage } from "@/src/components/article/chat-with-page";
import { CopyPage } from "@/src/components/article/copy-page";
import { useChatContext } from "@/src/components/chat/chat-context";
import { Footer } from "@/src/components/navigation/footer";
import {
  hasSectionTabs,
  SectionTabs,
} from "@/src/components/navigation/section-tabs";
import { Sidebar } from "@/src/components/sidebar";
import { TableOfContents } from "@/src/components/toc";

interface DocsPageProps {
  data: DocsRoutePageData;
}

type BundledMdxComponent = ComponentType<{
  components?: typeof components;
}>;

const ApiReferenceBody = lazy(() =>
  import("@/src/components/api-reference/api-reference-body").then(
    (module) => ({ default: module.ApiReferenceBody })
  )
);

// `import: "default"` pulls only the compiled React component, skipping the
// sibling `__rawSource` export injected by mdxSourceCapturePlugin. This keeps
// raw MDX out of the client bundle while the server adapter can still read it.
// The modules stay lazy because platform routes always use runtime documents.
// Standalone Vite routes load only the bundled page that they render. The
// platform renderer's server build has no local content, so it leaves the
// bundled pages out of the server bundle.
const bundledMdxLoaders: Record<string, () => Promise<BundledMdxComponent>> =
  import.meta.env.SSR && import.meta.env.DOXA_OMIT_LOCAL_CONTENT_SOURCE
    ? {}
    : import.meta.glob<BundledMdxComponent>("/src/contents/docs/**/index.mdx", {
        import: "default",
      });
const mdxModules = Object.fromEntries(
  Object.entries(bundledMdxLoaders).map(([path, loadComponent]) => [
    path,
    lazy(async () => ({ default: await loadComponent() })),
  ])
) as Record<string, LazyExoticComponent<BundledMdxComponent>>;

export function DocsPage({ data }: DocsPageProps) {
  const isDemoMode = useDemoMode();
  const { isOpen: chatOpen, setCurrentPageContext } = useChatContext();
  const { slug, document: pageDocument } = data;
  if (!pageDocument) {
    throw new Error(`Page route ${data.href} is missing its document.`);
  }

  const title =
    data.routeTitle ||
    pageDocument.frontmatter.title ||
    slug.split("/").pop() ||
    "Documentation";
  const description = pageDocument.frontmatter.description;
  const apiMethod = data.runtimeDocument?.ok
    ? data.runtimeDocument.document.frontmatter.apiMethod
    : pageDocument.frontmatter.apiMethod;
  const copyPageEnabled =
    data.features.copyPage.markdown || data.features.copyPage.rawText;
  const pageContext = useMemo<ChatPageContext>(
    () => ({
      slug,
      href: pageDocument.href,
      sourcePath: pageDocument.sourcePath,
      title,
      ...(description ? { description } : {}),
    }),
    [description, pageDocument.href, pageDocument.sourcePath, slug, title]
  );

  useEffect(() => {
    setCurrentPageContext(pageContext);
  }, [pageContext, setCurrentPageContext]);

  const endpointDocument =
    apiMethod && data.runtimeDocument?.ok
      ? data.runtimeDocument.document
      : null;
  const apiPath = endpointDocument?.frontmatter.apiPath;
  const referenceLayout = Boolean(endpointDocument && apiPath);
  const layout = docsLayout(useSiteConfig());
  // The tab bar's height offsets the sticky sidebar and table of contents.
  // With the tabs in the top bar, the bar is gone from lg.
  const tabsHeightClass = hasSectionTabs(data.sections)
    ? cn(
        "[--docs-tabs-h:3rem] sm:[--docs-tabs-h:3.5rem]",
        layout.sectionTabs === "in-navbar" && "lg:[--docs-tabs-h:0rem]"
      )
    : "";

  // "Page edge": the page column fills the window. From xl, where the table of
  // contents shows, the row is a grid of equal outer columns (at least the
  // 240px sidebar, so they stay equal on mid-size windows): the sidebar at
  // the left edge, the table of contents at the right edge, and the article
  // centered in the window, under the centered section tabs. The wrappers in
  // between have no box there. Below xl, the article takes the free space on
  // both sides instead. The shared prose styles force `max-width: 100%` and
  // `margin: 0` on the article itself, so the cap goes on a wrapper. With
  // "Beside content" every wrapper keeps its old box, or has none.
  const pageEdge = layout.sidebar === "page-edge";

  return (
    <div className={`flex flex-col ${tabsHeightClass}`}>
      <SectionTabs
        sections={data.sections}
        currentSectionSlug={data.currentSection?.slug ?? null}
        sectionHomeHrefs={data.sectionHomeHrefs}
      />
      <div
        className={cn(
          "flex items-start gap-4 md:gap-8 lg:gap-12",
          pageEdge &&
            "xl:grid xl:grid-cols-[minmax(240px,1fr)_minmax(0,52rem)_minmax(240px,1fr)]"
        )}
      >
        <Sidebar
          section={data.currentSection}
          routes={data.sectionNavigation}
        />
        <div className={cn("min-w-0 flex-1 pt-6", pageEdge && "xl:contents")}>
          <div
            key={slug}
            className={cn(
              "flex items-start gap-6 lg:gap-10",
              pageEdge && "xl:contents"
            )}
          >
            <div
              className={
                pageEdge
                  ? "mx-auto w-full max-w-[52rem] min-w-0 flex-1 xl:pt-6"
                  : "contents"
              }
            >
              <article className="prose-code:font-code @container/article prose w-full max-w-3xl min-w-0 flex-1 prose-zinc dark:prose-invert prose-headings:scroll-m-20 prose-headings:scroll-mt-[calc(var(--docs-navbar-h)+var(--docs-tabs-h)+1rem)] prose-code:before:content-none prose-code:after:content-none prose-pre:border prose-pre:bg-muted/25 prose-img:rounded-md">
                {data.sectionHeading && (
                  <p className="not-prose mb-2 text-sm font-medium text-primary">
                    {data.sectionHeading}
                  </p>
                )}
                <div className="not-prose flex flex-col gap-3 @2xl/article:flex-row @2xl/article:items-start @2xl/article:justify-between">
                  <ArticleTitle title={title} apiMethod={apiMethod} />
                  <div className="flex shrink-0 flex-wrap items-center gap-2 @2xl/article:order-last">
                    {isChatAvailable(data.features) &&
                      data.features.ai.chatWithPage && (
                        <ChatWithPage pageContext={pageContext} />
                      )}
                    {copyPageEnabled && (
                      <CopyPage
                        options={data.features.copyPage}
                        rawDoc={
                          data.features.copyPage.markdown
                            ? () => loadDocsRawPage({ data: pageDocument.href })
                            : null
                        }
                        title={title}
                        description={description}
                        apiMethod={apiMethod}
                        markdownUrl={
                          data.features.rawMarkdown
                            ? rawMarkdownUrl(pageDocument.href)
                            : null
                        }
                      />
                    )}
                  </div>
                </div>
                {description && (
                  <p className="not-prose mt-3 text-lg text-muted-foreground">
                    {description}
                  </p>
                )}
                {referenceLayout && endpointDocument && apiPath && apiMethod ? (
                  <Suspense
                    fallback={<ContentLoadingState label="API reference" />}
                  >
                    <ApiReferenceBody
                      document={endpointDocument}
                      method={apiMethod}
                      path={apiPath}
                      features={data.features}
                    />
                  </Suspense>
                ) : (
                  <div className="prose-content mt-8">
                    <MdxContent
                      slug={slug}
                      runtimeDocument={data.runtimeDocument}
                    />
                  </div>
                )}
                <ArticleEnd
                  pathname={slug}
                  previous={data.previous}
                  next={data.next}
                />
                {!isDemoMode && <Footer />}
              </article>
            </div>
            {!chatOpen && (
              <TableOfContents
                tocs={{ tocs: pageDocument.tocs }}
                pathName={slug}
                frontmatter={pageDocument.frontmatter}
                // A grid item at the right edge. The top offset replaces the
                // padding of the wrapper that has no box there.
                className={pageEdge ? "xl:mt-6 xl:justify-self-end" : undefined}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MdxContent({
  slug,
  runtimeDocument,
}: {
  slug: string;
  runtimeDocument?: ParsedDocument | null;
}) {
  if (runtimeDocument?.ok) {
    return (
      <RuntimeMdxContent
        document={runtimeDocument.document}
        components={components}
        elements={elements}
      />
    );
  }

  if (runtimeDocument && !runtimeDocument.ok) {
    return (
      <div className="not-prose border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        <p className="font-medium">This page could not be rendered.</p>
        <p className="mt-2 font-mono text-xs">
          {import.meta.env.DEV
            ? runtimeDocument.error
            : `Error code: ${runtimeDocument.code}`}
        </p>
      </div>
    );
  }

  // Default-section pages have rootless URLs. Non-default sections keep their
  // section prefix. The rootless lookup must win when both files exist.
  const MDXContent =
    mdxModules[`/src/contents/docs/${slug}/index.mdx`] ??
    mdxModules[`/src/contents/docs/default/${slug}/index.mdx`];

  if (!MDXContent) {
    return (
      <p className="text-destructive">
        This bundled documentation page could not be rendered.
      </p>
    );
  }

  return (
    <Suspense fallback={<ContentLoadingState label="documentation" />}>
      <MDXContent components={{ ...components, ...elements }} />
    </Suspense>
  );
}

/** The page's `.md` route (`src/lib/raw-markdown.ts`). The site root has none. */
function rawMarkdownUrl(href: string): string | null {
  const path = href.replace(/\/+$/, "");
  return path ? `${path}.md` : null;
}

function ContentLoadingState({ label }: { label: string }) {
  return (
    <p className="not-prose text-sm text-muted-foreground" aria-live="polite">
      Loading {label}…
    </p>
  );
}
