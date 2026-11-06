import type {
  DocPage,
  DocumentationStructure,
  ProjectAnalysis,
  RestApiReferenceAuth,
  RestApiReferenceEndpoint,
  RestApiReferenceField,
  RestApiReferenceParameter,
  RestApiReferenceResponse,
  RestApiReferenceSurface,
  WriterContext,
} from "../types";
import type { AgentSpanCallback } from "../core/types";
import { compileMdx } from "../utils/mdx-compile";
import { endpointPageTitle } from "./reference-surfaces";
import { buildRouteRegistry, pageOutputPath } from "./route-registry";
import { StructurePipelineDefectError } from "./structure-review-errors";
import {
  DEFAULT_REST_API_DOCS_POLICY,
  isRestApiPlaygroundEnabled,
  playgroundServerUrl,
  resolveRestApiDocsPolicy,
  type RestApiDocsPolicy,
} from "./rest-api-policy";
import {
  buildRestRequestModel,
  buildRestRequestSample,
  type RestRequestClientId,
} from "./rest-request-samples";
import type { DoxabotCodeLanguage } from "@doxahq/contracts/doxabot-instructions";
import { exampleFromFields } from "./rest-json-example";

const DEFAULT_API_BASE_URL = "https://api.example.com";
const REST_REFERENCE_OPEN = "<ApiEndpoint ";
const REST_REFERENCE_CLOSE = "</ApiEndpoint>";

export function renderRestEndpointReferenceBlock(
  endpoint: RestApiReferenceEndpoint,
  surface: RestApiReferenceSurface,
  options: RestEndpointReferenceOptions = {},
): string {
  const policy = options.policy ?? DEFAULT_REST_API_DOCS_POLICY;
  const requestBaseUrl = curlBaseUrl(surface);
  const interactiveBaseUrl = playgroundBaseUrl(surface, policy);
  const sections = [
    renderRequestExamples(endpoint, requestBaseUrl, policy),
    ...renderResponseExamples(endpoint.responses ?? []),
    renderAuthorizationGroup(
      endpoint.authRequirement,
      surface,
      policy,
      options.authenticationRoute,
    ),
    renderParameterGroup(policy.paramGroupTitles.path, "path", endpoint.parameters ?? []),
    renderParameterGroup(policy.paramGroupTitles.query, "query", endpoint.parameters ?? []),
    renderParameterGroup(policy.paramGroupTitles.header, "header", endpoint.parameters ?? []),
    renderFieldGroup(
      policy.paramGroupTitles.body,
      "body",
      endpoint.bodyFields ?? [],
      endpoint.bodyContentType,
    ),
    renderResponseSchema(endpoint.responses ?? [], policy),
  ].filter((section): section is string => Boolean(section));

  return [
    `<ApiEndpoint method=${attribute(endpoint.method.toUpperCase())} path=${attribute(endpoint.path)}${interactiveBaseUrl ? ` baseUrl=${attribute(interactiveBaseUrl)}` : ""}>`,
    "",
    sections.join("\n\n"),
    "",
    "</ApiEndpoint>",
  ].join("\n");
}
export interface RestEndpointReferenceOptions {
  readonly policy?: RestApiDocsPolicy;
  readonly authenticationRoute?: string;
}

export interface ResolvedRestEndpoint {
  readonly endpoint: RestApiReferenceEndpoint;
  readonly surface: RestApiReferenceSurface;
}

export { isRestEndpointPage } from "./page-renderer-kind";

export function restFrontmatterMetadata(
  page: Pick<DocPage, "reference">,
): { apiMethod?: string; apiPath?: string } {
  const reference = page.reference;
  if (reference?.kind !== "rest" || !reference.endpointId) return {};
  return {
    apiMethod: reference.method,
    apiPath: reference.path,
  };
}

export function resolveRestEndpoint(
  page: Pick<DocPage, "reference">,
  analysis: ProjectAnalysis | undefined,
): ResolvedRestEndpoint | undefined {
  const reference = page.reference;
  const surface = analysis?.referenceSurfaces?.rest;
  if (
    reference?.kind !== "rest" ||
    !reference.groupId ||
    !reference.endpointId ||
    !surface
  ) {
    return undefined;
  }

  const endpoint = surface.groups
    .find((group) => group.id === reference.groupId)
    ?.endpoints.find((candidate) => candidate.id === reference.endpointId);
  return endpoint ? { endpoint, surface } : undefined;
}

/** The policy and shared auth link that every endpoint page of one run uses. */
export function restEndpointReferenceOptions(
  writerContext: WriterContext | undefined,
): RestEndpointReferenceOptions {
  const policy = resolveRestApiDocsPolicy(writerContext?.answers ?? {});
  const codeLanguages = writerContext?.documentationBrief?.projectInstructions?.instructions.codeLanguages ?? [];
  return {
    policy: {
      ...policy,
      requestClients: Object.freeze(orderRequestClientsByLanguage(policy.requestClients, codeLanguages)),
    },
    authenticationRoute: writerContext?.structure
      ? restAuthenticationRoute(writerContext.structure)
      : undefined,
  };
}

const REQUEST_CLIENT_LANGUAGES: Readonly<Record<RestRequestClientId, DoxabotCodeLanguage>> = {
  curl: "curl",
  "node-fetch": "javascript",
  "node-xhr": "javascript",
  "python-requests": "python",
  "python-httpx": "python",
  go: "go",
};

/** A request client's place in the owner's language order. TypeScript readers get the JavaScript clients. */
function ownerLanguageRank(client: RestRequestClientId, codeLanguages: readonly DoxabotCodeLanguage[]): number {
  const language = REQUEST_CLIENT_LANGUAGES[client];
  const readers: readonly DoxabotCodeLanguage[] = language === "javascript" ? ["javascript", "typescript"] : [language];
  const ranks = readers
    .map((candidate) => codeLanguages.indexOf(candidate))
    .filter((rank) => rank >= 0);
  return ranks.length > 0 ? Math.min(...ranks) : codeLanguages.length;
}

/**
 * The request samples in the owner's code language order. The project's own
 * client list decides which samples exist; the owner's languages only order
 * them, and clients in a language the owner did not name follow in their order.
 */
export function orderRequestClientsByLanguage(
  clients: readonly RestRequestClientId[],
  codeLanguages: readonly DoxabotCodeLanguage[],
): RestRequestClientId[] {
  if (codeLanguages.length === 0) return [...clients];
  return clients
    .map((client, position) => ({ client, position, rank: ownerLanguageRank(client, codeLanguages) }))
    .sort((a, b) => a.rank - b.rank || a.position - b.position)
    .map(({ client }) => client);
}

/** Places the deterministic block after the page prose, as the last block. */
export function appendRestEndpointReferenceBlock(
  content: string,
  block: string,
): string {
  return `${content.trimEnd()}\n\n${block}\n`;
}

function restAuthenticationRoute(
  structure: DocumentationStructure,
): string | undefined {
  for (const section of structure.sections) {
    const page = section.pages.find((candidate) =>
      candidate.reference?.kind === "rest" &&
      candidate.reference.pageKind === "auth"
    );
    if (!page) continue;

    const outputPath = pageOutputPath(section, page);
    return buildRouteRegistry(structure).entries.find(
      (entry) => entry.outputPath === outputPath,
    )?.route;
  }
  return undefined;
}

/**
 * The deterministic block is appended after the writer's own validation pass,
 * so it is the one content class with no repair path: if it were malformed the
 * reader would get a render failure with no fallback. Validate it here and fail
 * as a pipeline defect — this block is generated by us, never by the model, so
 * a model repair loop cannot fix it.
 */
export async function assertRestEndpointPageRenders(
  content: string,
  endpointId: string,
  onSpan?: AgentSpanCallback,
): Promise<void> {
  const compiled = await compileMdx(content, { onSpan });
  if (compiled.ok) return;

  const detail = compiled.errors
    .map((error) => `${error.rule}: ${error.message}`)
    .join("; ");
  throw new StructurePipelineDefectError(
    `Deterministic REST reference block for endpoint "${endpointId}" produced ` +
      `invalid MDX (${detail}). This is a defect in reference page generation, ` +
      "not in the model output.",
  );
}

export function stripRestEndpointReferenceBlock(content: string): string {
  const start = content.lastIndexOf(REST_REFERENCE_OPEN);
  if (start < 0) return content;
  const closeStart = content.indexOf(REST_REFERENCE_CLOSE, start);
  if (closeStart < 0) return content;
  const end = closeStart + REST_REFERENCE_CLOSE.length;
  return `${content.slice(0, start)}${content.slice(end)}`.trimEnd();
}

function curlBaseUrl(surface: RestApiReferenceSurface): string {
  return surface.baseUrl?.trim() || surface.servers?.find((server) => server.trim())?.trim() ||
    DEFAULT_API_BASE_URL;
}

/** The URL the playground calls; only a public `https:` server, never a local or private one. */
function playgroundBaseUrl(
  surface: RestApiReferenceSurface,
  policy: RestApiDocsPolicy,
): string | undefined {
  if (!isRestApiPlaygroundEnabled(surface, policy)) return undefined;
  return playgroundServerUrl(surface);
}

function renderRequestExamples(
  endpoint: RestApiReferenceEndpoint,
  baseUrl: string,
  policy: RestApiDocsPolicy,
): string {
  const model = buildRestRequestModel(endpoint, baseUrl);
  const label = endpointPageExampleLabel(endpoint);
  return policy.requestClients.map((client) => {
    const sample = buildRestRequestSample(client, model);
    return [
      `<ApiRequestExample client=${attribute(sample.client)} lang=${attribute(sample.lang)} label=${attribute(label)}>`,
      "",
      renderCodeFence(sample.lang, sample.code),
      "",
      "</ApiRequestExample>",
    ].join("\n");
  }).join("\n\n");
}

/**
 * The code-sample label must match the page title a reader sees in the H1 and
 * sidebar. `endpoint.title` is the raw analysis value, which may still be the
 * legacy method-and-path string, so resolve it through the same policy the page
 * title uses instead of reading it directly.
 */
function endpointPageExampleLabel(endpoint: RestApiReferenceEndpoint): string {
  return endpointPageTitle(endpoint) || `${endpoint.method.toUpperCase()} request`;
}

function renderResponseExamples(
  responses: readonly RestApiReferenceResponse[],
): string[] {
  return responses.map((response) => {
    const example = response.example ?? prettyJsonExample(response.fields ?? []);
    return [
      `<ApiResponseExample status=${attribute(response.statusLabel ?? String(response.status))} contentType=${attribute(response.contentType ?? "application/json")}>`,
      "",
      renderCodeFence("json", example),
      "",
      "</ApiResponseExample>",
    ].join("\n");
  });
}

function renderAuthorizationGroup(
  auth: RestApiReferenceAuth | undefined,
  surface: RestApiReferenceSurface,
  policy: RestApiDocsPolicy,
  authenticationRoute: string | undefined,
): string | undefined {
  if (!auth || auth.scheme === "none") return undefined;
  const location = auth.location ?? "header";
  const name = auth.name ?? (auth.scheme === "apiKey" ? (location === "header" ? "X-API-Key" : "api_key") : "Authorization");
  const description = appendAuthenticationLink(
    auth.description ?? defaultAuthDescription(auth.scheme),
    surface,
    policy,
    authenticationRoute,
  );
  return renderParams(policy.paramGroupTitles.auth, [{
    name,
    type: auth.scheme,
    location,
    required: true,
    description,
  }]);
}

function appendAuthenticationLink(
  description: string,
  surface: RestApiReferenceSurface,
  policy: RestApiDocsPolicy,
  authenticationRoute: string | undefined,
): string {
  if (
    !policy.authPage.enabled ||
    !surface.authSchemes?.length ||
    !authenticationRoute
  ) {
    return description;
  }

  const normalizedDescription = description.trim().replace(/[.!?]+$/, "");
  return `${normalizedDescription}. See [${policy.authPage.linkText}](${authenticationRoute}).`;
}

function defaultAuthDescription(scheme: RestApiReferenceAuth["scheme"]): string {
  switch (scheme) {
    case "bearer": return "Provide a bearer access token.";
    case "apiKey": return "Provide the API key issued for this service.";
    case "basic": return "Provide HTTP Basic credentials.";
    case "oauth2": return "Provide a valid OAuth 2 access token.";
    case "none": return "No authorization is required.";
  }
}

function renderParameterGroup(
  title: string,
  location: RestApiReferenceParameter["in"],
  parameters: readonly RestApiReferenceParameter[],
): string | undefined {
  const matching = parameters
    .filter((parameter) => parameter.in === location)
    .map((parameter) => ({
      name: parameter.name,
      type: parameter.type,
      location,
      required: parameter.required,
      description: parameterDescription(parameter),
      ...(parameter.enumValues?.length ? { enumValues: parameter.enumValues } : {}),
      ...(parameter.example ? { example: parameter.example } : {}),
    }));
  return matching.length > 0 ? renderParams(title, matching) : undefined;
}

/** The source description, allowed values and example; empty when the source has none of them. */
function parameterDescription(parameter: RestApiReferenceParameter): string {
  return describedValue(parameter.description, parameter.example, parameter.enumValues);
}

function describedValue(description: string | undefined, example: string | undefined, enumValues?: readonly string[]): string {
  return [
    description,
    enumValues?.length ? `Allowed values: ${enumValues.join(", ")}.` : undefined,
    example ? `Example: ${example}.` : undefined,
  ].filter((value): value is string => Boolean(value)).join(" ");
}

function renderFieldGroup(
  title: string,
  location: "body" | "response",
  fields: readonly RestApiReferenceField[],
  detail?: string,
): string | undefined {
  if (fields.length === 0) return undefined;
  return renderParams(title, fields.map((field) => ({
    name: field.name,
    type: field.type,
    location,
    required: field.required,
    description: describedValue(field.description, field.example),
    ...(location === "body" && field.example ? { example: field.example } : {}),
  })), detail);
}

function renderResponseSchema(
  responses: readonly RestApiReferenceResponse[],
  policy: RestApiDocsPolicy,
): string | undefined {
  const responseWithFields = responses.find((response) => (response.fields?.length ?? 0) > 0);
  return responseWithFields
    ? renderFieldGroup(
      policy.paramGroupTitles.response,
      "response",
      responseWithFields.fields ?? [],
      responseWithFields.contentType,
    )
    : undefined;
}

interface RenderedParameter {
  name: string;
  type: string;
  location: string;
  required: boolean;
  description: string;
  enumValues?: readonly string[];
  example?: string;
}

/** The props that the playground reads. A value with a comma cannot go in the list. */
function playgroundProps(parameter: RenderedParameter): string {
  const enumValues = parameter.enumValues?.every((value) => !value.includes(","))
    ? parameter.enumValues.join(",")
    : undefined;
  return [
    enumValues ? ` enum=${attribute(enumValues)}` : "",
    parameter.example ? ` example=${attribute(parameter.example)}` : "",
  ].join("");
}

function renderParams(
  title: string,
  parameters: readonly RenderedParameter[],
  detail?: string,
): string {
  return [
    `<ApiParams title=${attribute(title)}${detail ? ` detail=${attribute(detail)}` : ""}>`,
    ...parameters.flatMap((parameter) => {
      const opening = `  <ApiParam name=${attribute(parameter.name)} type=${attribute(parameter.type)} location=${attribute(parameter.location)}${parameter.required ? " required" : ""}${playgroundProps(parameter)}`;
      // The type and the name say all that the source gives; no filler sentence.
      return parameter.description
        ? [`${opening}>`, `    ${mdxText(parameter.description)}`, "  </ApiParam>"]
        : [`${opening} />`];
    }),
    "</ApiParams>",
  ].join("\n");
}

function prettyJsonExample(fields: readonly RestApiReferenceField[]): string {
  return JSON.stringify(exampleFromFields(fields), null, 2);
}

function attribute(value: string): string {
  return `"${value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;")
    .replace(/\r\n?|\n/g, "&#10;")}"`;
}

function renderCodeFence(language: string, content: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(content.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}${language}\n${content}\n${fence}`;
}

/**
 * Escapes source-backed prose so MDX reads it as text, never as JSX, an
 * expression or an ESM line: a line that starts with `import` or `export`
 * gets its first letter as a character reference.
 */
export function mdxText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;")
    .replace(/^([ \t]*)(import|export)\b/gm, (_match, indent: string, keyword: string) =>
      `${indent}&#${keyword.charCodeAt(0)};${keyword.slice(1)}`
    );
}
