import { createRouter as createTanStackRouter } from "@tanstack/react-router";

import { resetDocsScrollOnNewPage } from "./lib/docs-scroll";
import { docsRouterPreloadPolicy } from "./lib/preload-policy";
import { routeTree } from "./routeTree.gen";

export function createRouter() {
  const router = createTanStackRouter({
    routeTree,
    ...docsRouterPreloadPolicy,
    // A URL with a #hash lands on its heading: the inline script in
    // __root.tsx before the first paint, then the scroll spy. A restored
    // position would move the page away from it.
    scrollRestoration: ({ location }) => !location.hash,
    scrollRestorationBehavior: "instant",
    // No `scrollToTopSelectors`: see `resetDocsScrollOnNewPage`.
  });
  resetDocsScrollOnNewPage(router);

  return router;
}

export function getRouter() {
  return createRouter();
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createRouter>;
  }
}
