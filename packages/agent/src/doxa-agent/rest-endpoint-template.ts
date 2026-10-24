import type { RestApiReferenceEndpoint } from "../types";
import { runPageValidation } from "../utils/page-validator";
import type { DeterministicPageRenderInput } from "./deterministic-pages";
import {
  appendRestEndpointReferenceBlock,
  mdxText,
  renderRestEndpointReferenceBlock,
  resolveRestEndpoint,
  restEndpointReferenceOptions,
  restFrontmatterMetadata,
} from "./rest-endpoint-page";
import { StructurePipelineDefectError } from "./structure-review-errors";
import { composePageDescription } from "./writer";
import { composeWriterPage } from "./writer-pipeline";

/**
 * Renders a REST endpoint page from the analyzed endpoint alone. The page has
 * the shape of a model-written endpoint page: the same frontmatter, then the
 * analysis description as the introduction when analysis has one, then the
 * deterministic reference block. No model text is added.
 */
export async function renderRestEndpointTemplatePage(
  input: DeterministicPageRenderInput,
): Promise<string> {
  const { page, pageId } = input;
  const resolved = resolveRestEndpoint(page, input.writerContext?.analysis);
  if (!resolved) {
    throw new StructurePipelineDefectError(
      `REST endpoint page "${pageId}" references endpoint ` +
        `"${page.reference?.endpointId ?? ""}" in group ` +
        `"${page.reference?.groupId ?? ""}", which the analysis does not ` +
        "contain. The structure and the analysis are out of sync.",
    );
  }

  const prose = composeWriterPage({
    title: page.title,
    description: composePageDescription(input.promptRegistry, page.description),
    ...restFrontmatterMetadata(page),
    preserveTitle: true,
    leadingTitleHeading: false,
  }, restEndpointIntroduction(resolved.endpoint));
  const content = appendRestEndpointReferenceBlock(
    prose,
    renderRestEndpointReferenceBlock(
      resolved.endpoint,
      resolved.surface,
      restEndpointReferenceOptions(input.writerContext),
    ),
  );

  await assertTemplatePagePasses(content, input);
  return content;
}

/** The analysis description, after a deprecation line when the spec marks the endpoint deprecated. */
function restEndpointIntroduction(endpoint: RestApiReferenceEndpoint): string {
  const description = endpoint.description.trim();
  return [
    endpoint.deprecated ? "**This endpoint is deprecated.**" : "",
    description ? mdxText(description) : "",
  ].filter(Boolean).join("\n\n");
}

/**
 * Runs the writer's server-side gate on the complete page. The MDX compile
 * always runs: no repair step exists for template output, so a failure here
 * is a defect in the template, never something a retry can fix.
 */
async function assertTemplatePagePasses(
  content: string,
  input: DeterministicPageRenderInput,
): Promise<void> {
  const report = await runPageValidation(content, {
    mdxCompile: true,
    timeoutMs: input.writerValidation.timeoutMs,
    preserveTitle: true,
    restEndpointPage: true,
    onSpan: input.onSpan,
  });
  if (report.issues.length === 0) return;

  const detail = report.issues
    .map((issue) => `${issue.rule}: ${issue.message}`)
    .join("; ");
  throw new StructurePipelineDefectError(
    `Template REST endpoint page "${input.pageId}" failed page validation ` +
      `(${detail}). This is a defect in the page template, not in model output.`,
  );
}
