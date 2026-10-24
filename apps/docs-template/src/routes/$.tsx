import { loadDocsRouteDataForNavigation } from "@/src/runtime/runtime-route-data";
import { createFileRoute } from "@tanstack/react-router";

import {
  docsRouteSearchSchema,
  getDocsPageHead,
  requireDocsPageData,
} from "@/src/lib/docs-page-route";
import { DocsPage } from "@/src/components/docs-page";

export const Route = createFileRoute("/$")({
  validateSearch: docsRouteSearchSchema,
  loader: async ({ abortController, location, params, preload }) => {
    const pathname = params._splat ? `/${params._splat}` : location.pathname;
    const data = await loadDocsRouteDataForNavigation(
      pathname,
      abortController.signal,
      { destinationHref: location.href, preload }
    );

    return requireDocsPageData(data, location.search);
  },
  preload: true,
  staleTime: Infinity,
  component: SplatDocsPage,
  ssr: true,
  head: ({ loaderData }) => getDocsPageHead(loaderData),
});

function SplatDocsPage() {
  return <DocsPage data={Route.useLoaderData()} />;
}
