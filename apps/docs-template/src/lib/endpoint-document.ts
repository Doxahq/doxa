import type {
  RuntimeMdxDocument,
  RuntimeMdxElementNode,
  RuntimeMdxNode,
} from "@doxahq/mdx-runtime";

/**
 * Splits a generated REST endpoint page into the parts the reference layout
 * places in different columns.
 *
 * The generator emits one `<ApiEndpoint>` block that holds the request sample,
 * the response samples, and the parameter groups. The reference layout shows
 * the samples in a sticky right rail and the parameter groups in the main
 * column, so the tree has to be split before it reaches React.
 *
 * This runs on the parsed node tree instead of on rendered React children, so
 * it produces the same result on the server and in the browser.
 */

export type ApiParameterLocation =
  | "path"
  | "query"
  | "header"
  | "cookie"
  | "body"
  | "response";

export interface ApiParameterDefinition {
  name: string;
  type: string;
  location: ApiParameterLocation;
  required: boolean;
}

export interface EndpointCodeSample {
  /** Stable client id. Legacy request artifacts resolve to curl. */
  client: string;
  /** Card heading. The request label, or the response status. */
  label: string;
  /** Language or content type shown next to the heading. */
  detail?: string;
  /** Response status, present on response samples only. */
  status?: string;
  /** Plain text of the sample, for the copy button. */
  text: string;
  /** The original node, rendered through the normal component registry. */
  node: RuntimeMdxElementNode;
}

export interface EndpointDocument {
  baseUrl?: string;
  parameters: ApiParameterDefinition[];
  request: EndpointCodeSample[];
  responses: EndpointCodeSample[];
  /** The page without the extracted samples. */
  content: RuntimeMdxDocument;
}

const PARAMETER_LOCATIONS = new Set<string>([
  "path",
  "query",
  "header",
  "cookie",
  "body",
  "response",
]);

export function isElementNode(
  node: RuntimeMdxNode | undefined
): node is RuntimeMdxElementNode {
  return Boolean(node && node.type === "element");
}

/** Concatenates every text node under `node`, for the clipboard. */
export function nodeText(node: RuntimeMdxNode): string {
  if (node.type === "text") return node.value;
  return (node.children ?? []).map(nodeText).join("");
}

function stringProp(
  node: RuntimeMdxElementNode,
  name: string
): string | undefined {
  const value = node.props?.[name];
  if (value === undefined || value === null) return undefined;
  return String(value);
}

function toParameterLocation(value: string | undefined): ApiParameterLocation {
  return value && PARAMETER_LOCATIONS.has(value)
    ? (value as ApiParameterLocation)
    : "query";
}

function toRequestSample(node: RuntimeMdxElementNode): EndpointCodeSample {
  return {
    client: stringProp(node, "client") ?? "curl",
    label: stringProp(node, "label") ?? "Request",
    detail: stringProp(node, "lang") ?? "curl",
    text: nodeText(node).trim(),
    node,
  };
}

function toResponseSample(node: RuntimeMdxElementNode): EndpointCodeSample {
  const status = stringProp(node, "status") ?? "200";
  return {
    client: "",
    label: status,
    status,
    detail: stringProp(node, "contentType") ?? "application/json",
    text: nodeText(node).trim(),
    node,
  };
}

/**
 * Reads the endpoint parts and returns the page without its code samples.
 * A page with no `<ApiEndpoint>` block comes back unchanged, with empty parts.
 */
export function splitEndpointDocument(
  document: RuntimeMdxDocument
): EndpointDocument {
  const parameters: ApiParameterDefinition[] = [];
  const request: EndpointCodeSample[] = [];
  const responses: EndpointCodeSample[] = [];
  let baseUrl: string | undefined;

  function walk(nodes: RuntimeMdxNode[]): RuntimeMdxNode[] {
    const kept: RuntimeMdxNode[] = [];

    for (const node of nodes) {
      if (!isElementNode(node)) {
        kept.push(node);
        continue;
      }

      if (node.name === "ApiRequestExample") {
        request.push(toRequestSample(node));
        continue;
      }

      if (node.name === "ApiResponseExample") {
        responses.push(toResponseSample(node));
        continue;
      }

      if (node.name === "ApiEndpoint") {
        baseUrl = stringProp(node, "baseUrl") ?? baseUrl;
      }

      if (node.name === "ApiParam") {
        parameters.push({
          name: stringProp(node, "name") ?? "",
          type: stringProp(node, "type") ?? "string",
          location: toParameterLocation(stringProp(node, "location")),
          required: node.props?.required === true,
        });
      }

      kept.push({ ...node, children: walk(node.children ?? []) });
    }

    return kept;
  }

  const nodes = walk(document.nodes);

  return {
    ...(baseUrl ? { baseUrl } : {}),
    parameters,
    request,
    responses,
    content: { frontmatter: document.frontmatter, nodes },
  };
}

/** Splits `/v1/projects/{projectId}/flags` into its display segments. */
export interface EndpointPathSegment {
  value: string;
  parameter: boolean;
}

export function endpointPathSegments(path: string): EndpointPathSegment[] {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => ({
      value: segment,
      parameter: /^\{.+\}$/.test(segment),
    }));
}
