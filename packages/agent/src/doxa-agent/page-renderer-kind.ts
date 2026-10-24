import type { DocPage, DocumentationStructure } from "../types";
import { flattenStructure, stablePageId } from "./structure-utils";

/**
 * The ID of the template renderer for REST endpoint pages. It is part of the
 * page input hash: change it when the rendered output changes for the same
 * input.
 */
export const REST_ENDPOINT_TEMPLATE_RENDERER_ID = "rest-endpoint-template-v4";

/** One page per analyzed endpoint; overview, auth, and group pages are not endpoint pages. */
export function isRestEndpointPage(page: Pick<DocPage, "reference">): boolean {
  const reference = page.reference;
  return reference?.kind === "rest" && Boolean(reference.endpointId);
}

/**
 * The ID of the deterministic renderer that writes the page, or undefined
 * when the model writer does. Chooses by page kind only, so the choice is
 * known from the structure before analysis is loaded (page input hashes
 * need it).
 */
export function deterministicRendererIdFor(page: Pick<DocPage, "reference">): string | undefined {
  return isRestEndpointPage(page) ? REST_ENDPOINT_TEMPLATE_RENDERER_ID : undefined;
}

/**
 * True when a template renders the page. The API surface fixes such a page:
 * no model plans, reviews or writes it.
 */
export function isTemplateRenderedPage(page: Pick<DocPage, "reference">): boolean {
  return deterministicRendererIdFor(page) !== undefined;
}

/**
 * The stable IDs of the pages that a template renders, in structure order.
 * These pages make no model call, so they can be written in large groups.
 */
export function templateRenderedPageIds(structure: DocumentationStructure): string[] {
  return flattenStructure(structure)
    .filter((target) => isTemplateRenderedPage(target.page))
    .map(stablePageId);
}
