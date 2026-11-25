import type { AnyProductEvent, ProductAnalytics, ProductEventProperties } from "@doxahq/analytics";
import { createDb } from "@doxahq/db";
import type { Env } from "../../env";
import { isFirstBranchPublication, type PublicationAttribution } from "../../repositories/docs-publications";
import { productAnalyticsOf } from "../analytics/product-analytics";

export type DocsPublishVia = ProductEventProperties<"docs_published">["via"];

export interface DocsPublishedFacts {
  readonly userId: string;
  readonly projectId: string;
  readonly siteId: string;
  readonly via: DocsPublishVia;
}

/** A review publication closes a generation review; an agent publish carries its attribution. */
export function publishViaOf(input: {
  attribution?: PublicationAttribution | undefined;
  review: { backupBranchName: string | null } | null;
}): DocsPublishVia {
  if (input.review) return "review";
  return input.attribution ? "mcp" : "web";
}

export function docsPublishedEvent(facts: DocsPublishedFacts, firstPublish: boolean): AnyProductEvent {
  return {
    name: "docs_published",
    distinctId: facts.userId,
    properties: { first_publish: firstPublish, via: facts.via },
    groups: { project: facts.projectId },
  };
}

/**
 * `docs_published`, once the new version is live. The publication count is
 * read in the background: the publish answers without waiting, and
 * `flush()` waits for the read. Without analytics it reads nothing.
 */
export function reportDocsPublished(
  deps: { readonly analytics: ProductAnalytics; readonly isFirst: (siteId: string) => Promise<boolean> },
  facts: DocsPublishedFacts,
): void {
  deps.analytics.captureWhenReady(async () => [docsPublishedEvent(facts, await deps.isFirst(facts.siteId))]);
}

export function reportDocsPublishedInBackground(env: Env, facts: DocsPublishedFacts): void {
  const isFirst = (siteId: string) => isFirstBranchPublication(createDb(env), siteId);
  reportDocsPublished({ analytics: productAnalyticsOf(env), isFirst }, facts);
}
