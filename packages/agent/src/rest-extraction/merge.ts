import type {
  ProjectAnalysis,
  RestApiReferenceEndpoint,
  RestApiReferenceExtraction,
  RestApiReferenceField,
  RestApiReferenceGroup,
  RestApiReferenceParameter,
  RestApiReferenceSurface,
} from "../types";
import { endpointRouteId } from "../doxa-agent/reference-surfaces";
import { slugify } from "../doxa-agent/structure-utils";
import type { SecretRedactor } from "../reference-specs/secrets";
import { sanitizeSpecMarkdown, sanitizeSpecPlainText } from "../reference-specs/spec-text";
import { withRestSurface } from "../utils/analysis-rest-surface";
import { uniqueId } from "../utils/unique-id";
import type { ExtractedEndpointAnswer } from "./extract-unit";

/** One extracted endpoint and where it is registered. */
export interface ExtractedEndpoint {
  file: string;
  /** The line of the registration; 0 when it is not known. */
  line: number;
  endpoint: Omit<RestApiReferenceEndpoint, "id">;
}

const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_FIELD_DESCRIPTION_CHARS = 1_000;
const MAX_NAME_CHARS = 200;
const MAX_PATH_CHARS = 2_000;
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CONTROL_OR_SPACE = /[\s\u0000-\u001f\u007f-\u009f]/;

/**
 * An endpoint from a model answer, with the checks and the sanitizer of the
 * spec route: the model read source code that can hold hostile text.
 * Undefined when its method, path or a header name cannot be used.
 */
export function endpointFromAnswer(
  answer: ExtractedEndpointAnswer,
  redactor: SecretRedactor,
): ExtractedEndpoint | undefined {
  const path = answer.path.trim();
  if (!path.startsWith("/") || path.length > MAX_PATH_CHARS || CONTROL_OR_SPACE.test(path)) return undefined;

  const parameters = answer.parameters.flatMap((parameter): RestApiReferenceParameter[] => {
    const name = plain(parameter.name, MAX_NAME_CHARS, redactor);
    if (!name || (parameter.in === "header" && !HTTP_TOKEN.test(name))) return [];
    return [{
      name,
      in: parameter.in,
      type: plain(parameter.type, MAX_NAME_CHARS, redactor) ?? "string",
      required: parameter.in === "path" || parameter.required,
      ...optional("description", plain(parameter.description, MAX_FIELD_DESCRIPTION_CHARS, redactor)),
    }];
  });
  const fields = (list: ExtractedEndpointAnswer["bodyFields"]) =>
    list.flatMap((field) => fieldFromAnswer(field, redactor));

  const endpoint: Omit<RestApiReferenceEndpoint, "id"> = {
    title: plain(answer.title, MAX_NAME_CHARS, redactor) ?? "",
    method: answer.method.toUpperCase(),
    path,
    description: sanitizeSpecMarkdown(answer.description, MAX_DESCRIPTION_CHARS, redactor) ?? "",
    parameters,
    bodyFields: fields(answer.bodyFields),
    responses: answer.responses.map((response) => ({
      status: response.status,
      ...optional("description", plain(response.description, MAX_FIELD_DESCRIPTION_CHARS, redactor)),
      fields: fields(response.fields),
    })),
    sourceEvidence: [{ path: answer.file, kind: "source" }],
  };
  if (answer.bodyFields.length > 0) {
    endpoint.bodyContentType = plain(answer.bodyContentType, MAX_NAME_CHARS, redactor) ?? "application/json";
  }
  if (answer.auth !== "unknown") endpoint.authRequirement = { scheme: answer.auth };
  return { file: answer.file, line: answer.line ?? 0, endpoint };
}

/**
 * The endpoints that an earlier extraction found in the given files, from
 * the earlier analysis, in their earlier order.
 */
export function endpointsOfFiles(
  analysis: ProjectAnalysis | undefined,
  files: ReadonlySet<string>,
): ExtractedEndpoint[] {
  return (analysis?.referenceSurfaces?.rest?.groups ?? []).flatMap((group) =>
    group.endpoints.flatMap((endpoint): ExtractedEndpoint[] => {
      const file = endpoint.sourceEvidence[0]?.path;
      if (!file || !files.has(file)) return [];
      const { id: _id, ...rest } = endpoint;
      return [{ file, line: 0, endpoint: rest }];
    })
  );
}

/**
 * The analysis with the extracted endpoints in its REST surface. Each
 * endpoint joins the analysis group that lists the same method and path,
 * else the group that lists its file, else a group named after its first
 * path segment. One method and path appears once: the first by file and
 * line. A group without endpoints is left out.
 */
export function mergeExtractedEndpoints(
  analysis: ProjectAnalysis,
  extracted: readonly ExtractedEndpoint[],
  extraction: RestApiReferenceExtraction,
): ProjectAnalysis {
  const surface: RestApiReferenceSurface = analysis.referenceSurfaces?.rest ?? {
    label: "REST API",
    slug: "rest-api",
    sourceEvidence: [],
    groups: [],
  };
  const groupByRoute = new Map<string, string>();
  const groupByFile = new Map<string, string>();
  for (const group of surface.groups) {
    for (const endpoint of group.endpoints) {
      if (!groupByRoute.has(routeKey(endpoint))) groupByRoute.set(routeKey(endpoint), group.id);
    }
    for (const evidence of [...group.sourceEvidence, ...group.endpoints.flatMap((endpoint) => endpoint.sourceEvidence)]) {
      if (!groupByFile.has(evidence.path)) groupByFile.set(evidence.path, group.id);
    }
  }

  const endpointsByGroup = new Map<string, RestApiReferenceEndpoint[]>();
  const extraGroups = new Map<string, RestApiReferenceGroup>();
  const seenRoutes = new Set<string>();
  const endpointIds = new Set<string>();
  for (const { file, endpoint } of sortedByFileAndLine(extracted)) {
    const key = routeKey(endpoint);
    if (seenRoutes.has(key)) continue;
    seenRoutes.add(key);
    const groupId = groupByRoute.get(key) ?? groupByFile.get(file) ?? pathSegmentGroup(endpoint.path, extraGroups).id;
    const id = uniqueId(endpointRouteId(endpoint.method, endpoint.path), endpointIds);
    endpointsByGroup.set(groupId, [...(endpointsByGroup.get(groupId) ?? []), { id, ...endpoint }]);
  }

  const groups = [...surface.groups, ...extraGroups.values()]
    .map((group) => ({ ...group, endpoints: endpointsByGroup.get(group.id) ?? [] }))
    .filter((group) => group.endpoints.length > 0);
  return withRestSurface(analysis, { ...surface, extraction, groups });
}

/** The method and path of an endpoint, with colon parameters written as `{name}`. */
function routeKey(endpoint: Pick<RestApiReferenceEndpoint, "method" | "path">): string {
  const path = endpoint.path.replace(/\/:([A-Za-z_]\w*)/g, "/{$1}").replace(/\/+$/, "") || "/";
  return `${endpoint.method.toUpperCase()} ${path}`;
}

function sortedByFileAndLine(endpoints: readonly ExtractedEndpoint[]): ExtractedEndpoint[] {
  return endpoints
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) =>
      left.entry.file.localeCompare(right.entry.file) ||
      left.entry.line - right.entry.line ||
      left.index - right.index
    )
    .map(({ entry }) => entry);
}

function pathSegmentGroup(path: string, groups: Map<string, RestApiReferenceGroup>): RestApiReferenceGroup {
  const segment = path
    .split("/")
    .find((part) => part && !/^[{:]/.test(part) && !/^v\d+$/i.test(part)) ?? "general";
  const id = slugify(segment) || "general";
  const existing = groups.get(id);
  if (existing) return existing;
  const words = segment.replace(/[-_]+/g, " ");
  const group: RestApiReferenceGroup = {
    id,
    title: words.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase()),
    sourceEvidence: [],
    endpoints: [],
  };
  groups.set(id, group);
  return group;
}

function fieldFromAnswer(
  field: ExtractedEndpointAnswer["bodyFields"][number],
  redactor: SecretRedactor,
): RestApiReferenceField[] {
  const name = plain(field.name, MAX_PATH_CHARS, redactor);
  if (!name) return [];
  return [{
    name,
    type: plain(field.type, MAX_NAME_CHARS, redactor) ?? "string",
    required: field.required,
    ...optional("description", plain(field.description, MAX_FIELD_DESCRIPTION_CHARS, redactor)),
  }];
}

function plain(text: string | undefined, maxChars: number, redactor: SecretRedactor): string | undefined {
  return sanitizeSpecPlainText(text, maxChars, redactor);
}

function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  const result: { [P in K]?: string } = {};
  if (value !== undefined) result[key] = value;
  return result;
}
