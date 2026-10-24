import { loadDocsRouteDataForNavigation } from "@/src/runtime/runtime-route-data";
import { createFileRoute } from "@tanstack/react-router";

import {
  docsRouteSearchSchema,
  getDocsPageHead,
  requireDocsPageData,
} from "@/src/lib/docs-page-route";
import { DocsPage } from "@/src/components/docs-page";

export const Route = createFileRoute("/")({
  validateSearch: docsRouteSearchSchema,
  loader: async ({ abortController, location, preload }) => {
    const data = await loadDocsRouteDataForNavigation(
      "/",
      abortController.signal,
      { destinationHref: location.href, preload }
    );

    return requireDocsPageData(data, location.search);
  },
  preload: true,
  staleTime: Infinity,
  component: RootDocsPage,
  ssr: true,
  head: ({ loaderData }) => getDocsPageHead(loaderData),
});

function RootDocsPage() {
  return <DocsPage data={Route.useLoaderData()} />;
}
