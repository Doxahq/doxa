/**
 * Deterministic page renderers
 *
 * Some pages are fully defined by analyzed data, so a template renders them
 * and no model is called. The page loop asks {@link deterministicPageRendererFor}
 * first and sends every other page to the model writer. A later model step
 * (for example endpoint descriptions or examples) goes inside a renderer, so
 * the page loop does not change.
 */

import type { AgentSpanCallback } from "../core";
import type {
  DocPage,
  WriterContext,
  WriterValidationConfig,
} from "../types";
import type { PromptRegistry } from "./prompts";
import { isRestEndpointPage, REST_ENDPOINT_TEMPLATE_RENDERER_ID } from "./page-renderer-kind";
import { renderRestEndpointTemplatePage } from "./rest-endpoint-template";

export interface DeterministicPageRenderInput {
  readonly pageId: string;
  readonly page: DocPage;
  readonly writerContext: WriterContext | undefined;
  readonly writerValidation: WriterValidationConfig;
  readonly promptRegistry: PromptRegistry;
  readonly onSpan?: AgentSpanCallback;
}

export interface DeterministicPageRenderer {
  /**
   * Part of the page input hash. A cached page from another renderer, or
   * from the model writer, then never stands in for this renderer's output.
   * Change it when the rendered output changes for the same input.
   */
  readonly id: string;
  /** Returns the complete page, validated with the writer's own gates. */
  render(input: DeterministicPageRenderInput): Promise<string>;
}

const REST_ENDPOINT_TEMPLATE_RENDERER: DeterministicPageRenderer = {
  id: REST_ENDPOINT_TEMPLATE_RENDERER_ID,
  render: renderRestEndpointTemplatePage,
};

/**
 * Chooses by page kind only, so the choice is known from the structure
 * before analysis is loaded (page input hashes need it).
 */
export function deterministicPageRendererFor(
  page: Pick<DocPage, "reference">,
): DeterministicPageRenderer | undefined {
  if (isRestEndpointPage(page)) return REST_ENDPOINT_TEMPLATE_RENDERER;
  return undefined;
}
