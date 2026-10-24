import { getDemoRedirectSearch } from "@/src/runtime/demo-search";
import type {
  DocsRootRouteData,
  DocsRouteData,
  DocsRoutePageData,
} from "@/src/runtime/docs-route-data";
import { notFound, redirect } from "@tanstack/react-router";
import { z } from "zod";

import { formatApiTitle } from "./api-reference";

export const docsRouteSearchSchema = z.object({
  _splat: z.string().optional(),
  demo: z.union([z.boolean(), z.string(), z.number()]).optional(),
});

export function requireDocsPageData(
  data: DocsRouteData | DocsRootRouteData,
  search: Record<string, unknown>
): DocsRoutePageData {
  if (data.type === "redirect") {
    throw redirect({
      to: data.href,
      ...getDemoRedirectSearch(search),
    });
  }

  if (
    data.type === "empty" ||
    data.type === "router_not_found" ||
    data.type === "not_found"
  ) {
    throw notFound();
  }

  return data;
}

export function getDocsPageHead(loaderData: DocsRoutePageData | undefined) {
  if (!loaderData) return {};

  const document = loaderData.document;
  const title = loaderData.routeTitle || document?.frontmatter.title;
  const apiMethod = loaderData.runtimeDocument?.ok
    ? loaderData.runtimeDocument.document.frontmatter.apiMethod
    : document?.frontmatter.apiMethod;
  const description = document?.frontmatter.description;
  const keywords = document?.frontmatter.keywords;
  const pageTitle = title
    ? `${formatApiTitle(title, apiMethod)} – ${loaderData.site.name}`
    : loaderData.site.name;
  const pageDescription = description || loaderData.site.description || "";
  const pageUrl = loaderData.canonicalUrl;

  return {
    meta: [
      { title: pageTitle },
      { name: "description", content: pageDescription },
      ...(keywords ? [{ name: "keywords", content: keywords }] : []),
      { property: "og:type", content: "article" },
      { property: "og:title", content: pageTitle },
      { property: "og:description", content: pageDescription },
      { property: "og:url", content: pageUrl },
      { name: "twitter:title", content: pageTitle },
      { name: "twitter:description", content: pageDescription },
    ],
    links: [{ rel: "canonical", href: pageUrl }],
  };
}
