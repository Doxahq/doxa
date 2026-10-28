/// <reference types="vite/client" />
import { lazy, Suspense, type ComponentType, type ReactNode } from "react";
import { DemoModeProvider } from "@/src/contexts/demo-mode";
import { Providers } from "@/src/providers";
import type { DocsDeliveryCapability } from "@/src/runtime/request-context";
import { loadRootSiteConfig } from "@/src/site-config/root-site-config";
import {
  SiteConfigProvider,
  useSiteConfig,
} from "@/src/site-config/site-config-context";
import { ThemeStyle } from "@/src/site-config/theme-style";
import {
  resolveSiteConfig,
  sidebarPosition,
  toClientSiteConfig,
  type ClientSiteConfig,
} from "@doxahq/site-config";
import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";

import {
  DOCS_SCROLL_RESTORATION_ID,
  useDocsScrollReset,
} from "@/src/lib/docs-scroll";
import { HASH_SCROLL_SCRIPT } from "@/src/lib/hash-scroll-script";
import {
  ChatProvider,
  useChatContext,
} from "@/src/components/chat/chat-context";
import { FloatingChatBar } from "@/src/components/chat/floating-chat-bar";
import { Footer } from "@/src/components/navigation/footer";
import { Navbar } from "@/src/components/navigation/navbar";
import { NavigationProgress } from "@/src/components/navigation/navigation-progress";
import globalsCss from "@/src/styles/globals.css?url";

const fallbackConfig = toClientSiteConfig(resolveSiteConfig({}));

// The chat draws only in the browser, after a visitor opens it. The platform
// renderer serves no chat (see `chat-api.ts`), so its server build leaves the
// chat code out of the server bundle.
const ChatWithDocs = lazy<ComponentType>(() =>
  import.meta.env.SSR && import.meta.env.DOXA_OMIT_LOCAL_CONTENT_SOURCE
    ? Promise.resolve({ default: NoChat })
    : import("@/src/components/chat").then((module) => ({
        default: module.ChatWithDocs,
      }))
);
const DemoChatWithDocs = lazy(() =>
  import("@/src/components/chat/demo-chat").then((module) => ({
    default: module.DemoChatWithDocs,
  }))
);

export const Route = createRootRoute({
  loader: () => loadRootSiteConfig(),
  staleTime: Infinity,
  validateSearch: (search: Record<string, unknown>) => {
    const demo =
      search.demo === true ||
      search.demo === "true" ||
      search.demo === "" ||
      search.demo === 1 ||
      search.demo === "1";

    return demo ? { demo: true as const } : {};
  },
  head: ({ loaderData }) => ({
    meta: loaderData?.head.meta ?? [],
    links: [
      { rel: "stylesheet", href: globalsCss },
      ...(loaderData?.head.links ?? []),
    ],
  }),
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootComponent() {
  useDocsScrollReset();
  const { demo = false } = Route.useSearch();
  const { delivery, config, configHash } = Route.useLoaderData();
  return (
    <RootDocument
      delivery={delivery}
      config={config}
      configHash={configHash}
      isDemoMode={demo}
    >
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({
  children,
  delivery = null,
  config = fallbackConfig,
  configHash = "default",
  isDemoMode = false,
}: Readonly<{
  children: ReactNode;
  delivery?: DocsDeliveryCapability | null;
  config?: ClientSiteConfig;
  configHash?: string;
  isDemoMode?: boolean;
}>) {
  const appScrollStyle = {
    minWidth: 0,
    flex: "1 1 0%",
    overflowY: isDemoMode ? "hidden" : "auto",
    scrollbarGutter: isDemoMode ? undefined : "stable",
  } as const;

  return (
    <html
      lang="en"
      suppressHydrationWarning
      style={{ height: "100%", overflow: "hidden" }}
    >
      <head>
        <HeadContent />
        <ThemeStyle theme={config.theme} configHash={configHash} />
      </head>
      <body
        className="font-regular"
        style={{ height: "100%", margin: 0, overflow: "hidden" }}
      >
        <SiteConfigProvider config={config}>
          <NavigationProgress />
          <Providers>
            <DemoModeProvider value={isDemoMode}>
              <ChatProvider>
                <div
                  className="flex h-screen"
                  style={{ display: "flex", height: "100vh" }}
                >
                  <div
                    id="app-scroll-container"
                    data-scroll-restoration-id={DOCS_SCROLL_RESTORATION_ID}
                    className={`min-w-0 flex-1 ${isDemoMode ? "scrollbar-none overflow-y-hidden [&::-webkit-scrollbar]:hidden" : "overflow-y-auto"}`}
                    style={appScrollStyle}
                  >
                    <Navbar />
                    {/* "Page edge" drops the 1440px cap, so the sidebar and the
                        table of contents reach the window edges. */}
                    <main
                      className={`mx-auto h-auto min-h-[calc(100vh-12rem)] px-4 sm:px-6 md:px-8 ${sidebarPosition(config) === "page-edge" ? "" : "max-w-[1440px]"}`}
                    >
                      {children}
                    </main>
                    {!isDemoMode && <Footer />}
                  </div>
                  {/* Before the first paint: the scroll position of a refresh, and the current TOC item. */}
                  <script
                    dangerouslySetInnerHTML={{ __html: HASH_SCROLL_SCRIPT }}
                  />
                  <ChatInterface isDemoMode={isDemoMode} />
                </div>
              </ChatProvider>
            </DemoModeProvider>
          </Providers>
        </SiteConfigProvider>
        {delivery && (
          <script
            dangerouslySetInnerHTML={{
              __html: `window.__DOXA_DOCS_DELIVERY__=${serializeDeliveryCapability(delivery)};`,
            }}
          />
        )}
        <Scripts />
      </body>
    </html>
  );
}

function serializeDeliveryCapability(
  capability: DocsDeliveryCapability
): string {
  return JSON.stringify(capability).replace(/</g, "\\u003c");
}

function NoChat() {
  return null;
}

function ChatInterface({ isDemoMode }: { isDemoMode: boolean }) {
  const { isOpen } = useChatContext();
  const { features } = useSiteConfig();
  if (!features.ai.chat) return null;

  return (
    <>
      {isOpen && (
        <Suspense fallback={null}>
          {isDemoMode ? <DemoChatWithDocs /> : <ChatWithDocs />}
        </Suspense>
      )}
      {features.ai.floatingInput && !isDemoMode && <FloatingChatBar />}
    </>
  );
}

function NotFoundComponent() {
  return (
    <div className="flex min-h-[86.5vh] flex-col items-center justify-center px-2 py-8 text-center">
      <h1 className="mb-4 text-4xl font-bold sm:text-7xl">404</h1>
      <p className="mb-8 max-w-[600px] text-foreground sm:text-base">
        Page not found
      </p>
      <div className="flex items-center">
        <a
          href="/"
          className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground ring-offset-background hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Return Home
        </a>
      </div>
    </div>
  );
}

function ErrorComponent({ error }: { error: Error }) {
  return (
    <RootDocument>
      <section className="flex min-h-[99vh] flex-col items-start gap-3 px-2 py-8">
        <div>
          <h2 className="text-5xl font-bold">Oops!</h2>
          <p className="text-muted-foreground">Something went wrong!</p>
          {process.env.NODE_ENV === "development" && (
            <pre className="mt-4 overflow-auto rounded bg-muted p-4 text-sm">
              {error.message}
            </pre>
          )}
        </div>
        <a
          href="/"
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground ring-offset-background hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Go Home
        </a>
      </section>
    </RootDocument>
  );
}
