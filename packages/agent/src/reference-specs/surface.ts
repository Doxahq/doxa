import type {
  ParsedSpec,
  SpecField,
  SpecOperation,
  SpecParameter,
  SpecResponse,
  SpecSecurity,
  SpecSecurityScheme,
} from "@doxahq/contracts/spec-reader";
import type {
  RestApiReferenceAuth,
  RestApiReferenceEndpoint,
  RestApiReferenceField,
  RestApiReferenceGroup,
  RestApiReferenceParameter,
  RestApiReferenceResponse,
  RestApiReferenceSurface,
} from "../types";
import {
  endpointRouteId,
  isSpecEndpointTitle,
  MAX_SPEC_ENDPOINT_TITLE_LENGTH,
} from "../doxa-agent/reference-surfaces";
import { slugify } from "../doxa-agent/structure-utils";
import { sanitizeDisplayText } from "../utils/frontmatter";
import { hashObject } from "../utils/hash";
import { uniqueId } from "../utils/unique-id";
import { hasUnbalancedPunctuation } from "../utils/title-validation";
import type { SecretRedactor } from "./secrets";
import { sanitizeSpecMarkdown, sanitizeSpecPlainText } from "./spec-text";

const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_FIELD_DESCRIPTION_CHARS = 1_000;
const MAX_GROUP_TITLE_CHARS = 80;
const MAX_GROUP_ID_LENGTH = 120;

export interface SpecSurfaceInput {
  /** Parsed specs, in the order of their root paths. */
  specs: readonly ParsedSpec[];
  readerVersion: string;
  /** The SHA-256 of the text of every spec file the job read. */
  contentHash: string;
  redactor: SecretRedactor;
}

interface GroupDraft {
  name: string;
  title: string;
  description?: string;
  endpoints: RestApiReferenceEndpoint[];
}

interface SpecContext {
  root: string;
  schemes: ReadonlyMap<string, RestApiReferenceAuth>;
  /** Lower-case parameter names of API-key schemes, whose examples are credentials. */
  credentialNames: ReadonlySet<string>;
  redactor: SecretRedactor;
}

/**
 * The REST reference surface of the parsed specs, after gate G3. All text
 * is sanitized here, in the agent container, because the job output is
 * untrusted. Specs merge in root order: an operation that an earlier spec
 * already has is left out. Groups follow the tag order of each spec, and an
 * operation without a tag joins a group named after its first path segment.
 */
export function buildSpecSurface(input: SpecSurfaceInput): RestApiReferenceSurface {
  const groups = new Map<string, GroupDraft>();
  const seenRoutes = new Set<string>();
  const endpointIds = new Set<string>();
  const schemes = new Map<string, RestApiReferenceAuth>();

  for (const spec of input.specs) {
    const context = specContext(spec, input.redactor);
    for (const [name, auth] of context.schemes) if (!schemes.has(name)) schemes.set(name, auth);
    for (const tag of spec.tags) {
      const key = `tag:${tag.name}`;
      if (!groups.has(key)) {
        groups.set(key, {
          name: tag.name,
          title: groupTitle(tag.displayName ?? tag.name, tag.name, input.redactor),
          description: sanitizeSpecMarkdown(tag.description, MAX_DESCRIPTION_CHARS, input.redactor),
          endpoints: [],
        });
      }
    }
    for (const operation of spec.operations) {
      const route = `${operation.method} ${operation.path}`;
      if (seenRoutes.has(route)) continue;
      seenRoutes.add(route);
      // `/users/{userId}/posts` and `/users/posts` share a slug, and the
      // page template finds an endpoint by its ID, so IDs must be unique.
      const id = uniqueId(endpointRouteId(operation.method, operation.path), endpointIds);
      groupFor(groups, operation, input.redactor).endpoints.push(endpointOf(id, operation, context));
    }
  }

  const [firstSpec] = input.specs;
  const servers = uniqueServerUrls(input.specs);
  return {
    source: {
      kind: "openapi",
      specVersions: input.specs.map((spec) => spec.specVersion),
      files: [...new Set(input.specs.flatMap((spec) => spec.files))].sort(),
      contentHash: input.contentHash,
      readerVersion: input.readerVersion,
    },
    description: sanitizeSpecMarkdown(firstSpec?.info.description, MAX_DESCRIPTION_CHARS, input.redactor),
    sourceEvidence: input.specs.map((spec) => ({ path: spec.root, kind: "other" as const })),
    ...(servers.length > 0 ? { baseUrl: servers[0], servers } : {}),
    ...(schemes.size > 0 ? { authSchemes: uniqueAuth([...schemes.values()]) } : {}),
    groups: withGroupIds([...groups.values()].filter((group) => group.endpoints.length > 0)),
  };
}

function specContext(spec: ParsedSpec, redactor: SecretRedactor): SpecContext {
  const schemes = new Map(spec.securitySchemes.map((scheme) => [scheme.name, schemeAuth(scheme, redactor)]));
  const credentialNames = new Set(
    spec.securitySchemes.flatMap((scheme) => (scheme.parameterName ? [scheme.parameterName.toLowerCase()] : [])),
  );
  return { root: spec.root, schemes, credentialNames, redactor };
}

function groupFor(groups: Map<string, GroupDraft>, operation: SpecOperation, redactor: SecretRedactor): GroupDraft {
  const name = operation.tag ?? firstPathSegment(operation.path);
  const key = operation.tag ? `tag:${operation.tag}` : `path:${name}`;
  const existing = groups.get(key);
  if (existing) return existing;
  const group: GroupDraft = {
    name,
    title: groupTitle(name.replace(/[-_]+/g, " "), name, redactor),
    endpoints: [],
  };
  groups.set(key, group);
  return group;
}

/** The first path segment that is not a parameter or a version, such as `orders` in `/v1/orders/{id}`. */
function firstPathSegment(path: string): string {
  return path
    .split("/")
    .find((segment) => segment && !/^\{.*\}$/.test(segment) && !/^v\d+$/i.test(segment)) ?? "general";
}

/**
 * A group title that survives frontmatter cleanup as it is, else the name
 * in words. A tag such as `pets` or `user-accounts` starts with a capital.
 */
function groupTitle(text: string, name: string, redactor: SecretRedactor): string {
  const plain = sanitizeSpecPlainText(text, MAX_GROUP_TITLE_CHARS, redactor);
  const title = plain ? capitalize(sanitizeDisplayText(plain)) : "";
  if (title && sanitizeDisplayText(title) === title && !hasUnbalancedPunctuation(title)) return title;
  const words = name.replace(/[-_]+/g, " ").replace(/[^\p{L}\p{N} ]+/gu, "").trim();
  return words ? capitalize(words) : "Endpoints";
}

function capitalize(text: string): string {
  return text.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());
}

/**
 * Group IDs: the slug of the tag name; a hash when the name has no Latin
 * letter or digit; `-2`, `-3` for a slug that an earlier group took. Every
 * ID matches `^[a-z0-9-]{1,120}$`.
 */
function withGroupIds(groups: readonly GroupDraft[]): RestApiReferenceGroup[] {
  const taken = new Set<string>();
  return groups.map((group) => {
    const base = slugify(group.name).slice(0, MAX_GROUP_ID_LENGTH - 4).replace(/-+$/, "") ||
      `tag-${hashObject(group.name).slice(0, 8)}`;
    return {
      id: uniqueId(base, taken),
      title: group.title,
      ...(group.description ? { description: group.description } : {}),
      sourceEvidence: [],
      endpoints: group.endpoints,
    };
  });
}

function endpointOf(id: string, operation: SpecOperation, context: SpecContext): RestApiReferenceEndpoint {
  const { redactor } = context;
  const endpoint: RestApiReferenceEndpoint = {
    id,
    title: endpointTitle(operation.summary, redactor),
    method: operation.method,
    path: operation.path,
    // The summary is the title; repeating it as the description adds nothing.
    description: sanitizeSpecMarkdown(operation.description, MAX_DESCRIPTION_CHARS, redactor) ?? "",
    parameters: operation.parameters.map((parameter) => parameterOf(parameter, context)),
    responses: operation.responses.map((response) => responseOf(response, redactor)),
    sourceEvidence: [{ path: context.root, kind: "other" }],
  };
  if (operation.requestBody) {
    endpoint.bodyContentType = operation.requestBody.contentType;
    endpoint.bodyFields = operation.requestBody.fields.map((field) => fieldOf(field, redactor));
  }
  const auth = authRequirementOf(operation.security, context.schemes);
  if (auth) endpoint.authRequirement = auth;
  if (operation.deprecated) endpoint.deprecated = true;
  return endpoint;
}

/** The summary as the title when it can be one as it is; else empty, so the page derives a title. */
function endpointTitle(summary: string | undefined, redactor: SecretRedactor): string {
  const title = sanitizeSpecPlainText(summary, MAX_SPEC_ENDPOINT_TITLE_LENGTH, redactor)?.replace(/\.$/, "");
  return title && isSpecEndpointTitle(title) ? title : "";
}

function parameterOf(parameter: SpecParameter, context: SpecContext): RestApiReferenceParameter {
  const result: RestApiReferenceParameter = {
    name: parameter.name,
    in: parameter.in,
    type: parameter.type,
    required: parameter.required,
  };
  const description = sanitizeSpecPlainText(parameter.description, MAX_FIELD_DESCRIPTION_CHARS, context.redactor);
  if (description) result.description = description;
  if (parameter.example !== undefined) {
    result.example = context.redactor.redactExample(parameter.example, parameter.name, context.credentialNames);
  }
  if (parameter.enumValues?.length) result.enumValues = parameter.enumValues;
  return result;
}

function fieldOf(field: SpecField, redactor: SecretRedactor): RestApiReferenceField {
  const result: RestApiReferenceField = { name: field.name, type: field.type, required: field.required };
  const description = sanitizeSpecPlainText(field.description, MAX_FIELD_DESCRIPTION_CHARS, redactor);
  if (description) result.description = description;
  if (field.example !== undefined) result.example = redactor.redact(field.example);
  return result;
}

function responseOf(response: SpecResponse, redactor: SecretRedactor): RestApiReferenceResponse {
  const result: RestApiReferenceResponse = { status: response.status };
  if (response.statusLabel) result.statusLabel = response.statusLabel;
  if (response.contentType) result.contentType = response.contentType;
  const description = sanitizeSpecPlainText(response.description, MAX_FIELD_DESCRIPTION_CHARS, redactor);
  if (description) result.description = description;
  if (response.example !== undefined) result.example = redactor.redact(response.example);
  if (response.fields.length > 0) result.fields = response.fields.map((field) => fieldOf(field, redactor));
  return result;
}

function schemeAuth(scheme: SpecSecurityScheme, redactor: SecretRedactor): RestApiReferenceAuth {
  const auth: RestApiReferenceAuth = scheme.kind === "apiKey"
    ? { scheme: "apiKey", location: scheme.location, name: scheme.parameterName }
    : { scheme: scheme.kind === "openIdConnect" ? "oauth2" : scheme.kind };
  const description = sanitizeSpecPlainText(scheme.description, MAX_FIELD_DESCRIPTION_CHARS, redactor);
  if (description) auth.description = description;
  return auth;
}

/** No auth, or the first scheme of the first requirement that the spec declares. */
function authRequirementOf(
  security: SpecSecurity | undefined,
  schemes: ReadonlyMap<string, RestApiReferenceAuth>,
): RestApiReferenceAuth | undefined {
  if (!security) return undefined;
  if (security.kind === "none") return { scheme: "none" };
  for (const name of security.schemeNames) {
    const auth = schemes.get(name);
    if (auth) return auth;
  }
  return undefined;
}

function uniqueAuth(auths: readonly RestApiReferenceAuth[]): RestApiReferenceAuth[] {
  const seen = new Set<string>();
  return auths.filter((auth) => {
    const key = `${auth.scheme}:${auth.location ?? ""}:${auth.name ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Absolute `https:` and `http:` server URLs with no user name or password, in spec order. */
function uniqueServerUrls(specs: readonly ParsedSpec[]): string[] {
  const urls = new Set<string>();
  for (const server of specs.flatMap((spec) => spec.servers)) {
    try {
      const url = new URL(server.url);
      if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) {
        urls.add(server.url.replace(/\/+$/, ""));
      }
    } catch {
      // A relative server URL has no host to show.
    }
  }
  return [...urls];
}
