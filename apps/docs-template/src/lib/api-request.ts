import type { DocsTryMethod, DocsTryRequest } from "@doxahq/contracts/docs-try";

import { normalizeApiMethod } from "@/src/lib/api-reference";
import type { ApiParameterDefinition } from "@/src/lib/endpoint-document";

export type { ApiParameterDefinition };

/** How the body goes on the wire. `form` is URL-encoded. */
export type PlaygroundBodyKind = "json" | "form" | "text";

export interface BrowserRequestInput {
  method: string;
  path: string;
  baseUrl: string;
  parameters: readonly ApiParameterDefinition[];
  values: Readonly<Record<string, string>>;
  token: string;
  /** Text from the raw editor. When set, it replaces the body fields. */
  rawBody?: string;
  bodyKind?: PlaygroundBodyKind;
}

/** One request, before a transport turns it into a `fetch` or a proxy call. */
export interface PlaygroundRequest {
  method: string;
  /** Starts with `/`, under the base URL. It holds no query string. */
  path: string;
  query: [string, string][];
  headers: [string, string][];
  cookies: [string, string][];
  body?: { contentType: string; text: string };
}

const BODY_CONTENT_TYPES: Record<PlaygroundBodyKind, string> = {
  json: "application/json",
  form: "application/x-www-form-urlencoded",
  text: "text/plain",
};

// A pasted key must never turn into a header injection, and the generator
// names an API key "API key" when the source gives no header name.
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const DEFAULT_API_KEY_HEADER = "X-API-Key";
const DEFAULT_API_KEY_PARAMETER = "api_key";

export function isAuthParameter(parameter: ApiParameterDefinition): boolean {
  return (
    parameter.name.toLowerCase() === "authorization" ||
    ["bearer", "apikey", "basic", "oauth2"].includes(
      parameter.type.toLowerCase()
    )
  );
}

/** Parameters a reader fills in. Excludes response fields and credentials. */
export function requestInputParameters(
  parameters: readonly ApiParameterDefinition[]
): ApiParameterDefinition[] {
  return parameters.filter(
    (parameter) =>
      parameter.location !== "response" && !isAuthParameter(parameter)
  );
}

/**
 * The origin that a playground request goes to: the endpoint's base URL,
 * resolved against the docs page.
 */
export function requestTargetOrigin(baseUrl: string): string {
  try {
    return new URL(baseUrl, window.location.href).origin;
  } catch {
    return window.location.origin;
  }
}

/**
 * A token is kept per docs host and per target API origin (SEC-010). Page
 * content picks `baseUrl`, so a token entered for one API must never fill in
 * on an endpoint that sends it to another host.
 */
export function authStorageKey(baseUrl: string): string {
  return `doxa-api-token:${window.location.host}:${requestTargetOrigin(baseUrl)}`;
}

export function loadSessionAuthToken(baseUrl: string): string {
  return window.sessionStorage.getItem(authStorageKey(baseUrl)) ?? "";
}

export function saveSessionAuthToken(baseUrl: string, value: string): void {
  if (value) {
    window.sessionStorage.setItem(authStorageKey(baseUrl), value);
    return;
  }
  window.sessionStorage.removeItem(authStorageKey(baseUrl));
}

export function buildPlaygroundRequest(
  input: BrowserRequestInput
): PlaygroundRequest {
  const method = normalizeApiMethod(input.method) ?? "GET";
  let requestPath = input.path;
  const query: [string, string][] = [];
  const headers: [string, string][] = [];
  const cookies: [string, string][] = [];
  const bodyFields: { parameter: ApiParameterDefinition; value: string }[] = [];

  for (const parameter of input.parameters) {
    if (isAuthParameter(parameter)) {
      applyAuthorization(parameter, input.token, query, headers, cookies);
      continue;
    }
    const value = input.values[parameter.name];
    if (!value) continue;
    switch (parameter.location) {
      case "path":
        requestPath = requestPath.replace(
          `{${parameter.name}}`,
          encodeURIComponent(value)
        );
        break;
      case "query":
        query.push([parameter.name, value]);
        break;
      case "header":
        headers.push([parameter.name, value]);
        break;
      case "cookie":
        cookies.push([parameter.name, value]);
        break;
      case "body":
        bodyFields.push({ parameter, value });
        break;
      case "response":
        break;
    }
  }

  const body = buildBody(method, bodyFields, input);
  if (
    body &&
    !headers.some(([name]) => name.toLowerCase() === "content-type")
  ) {
    headers.push(["Content-Type", body.contentType]);
  }

  return {
    method,
    path: `/${requestPath.replace(/^[\\/]+/, "")}`,
    query,
    headers,
    cookies,
    ...(body ? { body } : {}),
  };
}

function buildBody(
  method: string,
  fields: readonly { parameter: ApiParameterDefinition; value: string }[],
  input: BrowserRequestInput
): PlaygroundRequest["body"] {
  if (method === "GET" || method === "HEAD") return undefined;
  const kind = input.bodyKind ?? "json";
  const contentType = BODY_CONTENT_TYPES[kind];

  if (input.rawBody !== undefined) {
    return input.rawBody ? { contentType, text: input.rawBody } : undefined;
  }
  if (fields.length === 0) return undefined;
  if (kind === "form") {
    const form = new URLSearchParams();
    for (const { parameter, value } of fields) {
      form.append(parameter.name, value);
    }
    return { contentType, text: form.toString() };
  }
  return {
    contentType: BODY_CONTENT_TYPES.json,
    text: JSON.stringify(bodyFieldsToJson(fields)),
  };
}

/** The typed, nested JSON value of the body fields. */
export function bodyFieldsToJson(
  fields: readonly { parameter: ApiParameterDefinition; value: string }[]
): Record<string, unknown> {
  // No prototype at any level, so a field named `__proto__.x` in page content
  // stays a plain key of the request.
  const root = Object.create(null) as Record<string, unknown>;
  for (const { parameter, value } of fields) {
    setNestedValue(
      root,
      parameter.name,
      withoutPrototypes(coerceBodyValue(parameter.type, value))
    );
  }
  return root;
}

const NUMBER_TYPE = /^(?:integer|int|int32|int64|number|float|double|decimal|long)$/;
const BOOLEAN_TYPE = /^(?:boolean|bool)$/;
const LIST_TYPE = /(?:\[\]|^array.*)$/;
const OBJECT_TYPE = /^(?:object|map|json|record)/;

export function coerceBodyValue(type: string, value: string): unknown {
  const normalized = type.trim().toLowerCase();
  if (NUMBER_TYPE.test(normalized)) {
    const number = Number(value);
    return value.trim() !== "" && Number.isFinite(number) ? number : value;
  }
  if (BOOLEAN_TYPE.test(normalized)) {
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }
  if (LIST_TYPE.test(normalized)) {
    const parsed = parseJson(value);
    if (Array.isArray(parsed)) return parsed;
    return value.split(",").map((item) => item.trim());
  }
  if (OBJECT_TYPE.test(normalized)) {
    const parsed = parseJson(value);
    return parsed === undefined ? value : parsed;
  }
  return value;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isPlainContainer(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A copy of a parsed value with no prototype at any level. A later field such as
 * `settings.__proto__.x` then stays inside the data of the request.
 */
function withoutPrototypes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPrototypes);
  if (!isPlainContainer(value)) return value;
  const copy = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    copy[key] = withoutPrototypes(item);
  }
  return copy;
}

const ARRAY_SEGMENT = /^(.+)\[\d*\]$/;

/** Sets `author.name` or `items[].id` under `root`. */
function setNestedValue(
  root: Record<string, unknown>,
  name: string,
  value: unknown
): void {
  const segments = name.split(".").filter(Boolean);
  let node = root;
  segments.forEach((segment, index) => {
    const isLast = index === segments.length - 1;
    const arrayKey = ARRAY_SEGMENT.exec(segment)?.[1];
    if (arrayKey) {
      const list = Array.isArray(node[arrayKey])
        ? (node[arrayKey] as unknown[])
        : [];
      node[arrayKey] = list;
      if (isLast) {
        list.push(value);
        return;
      }
      if (!isPlainContainer(list[0])) list[0] = Object.create(null);
      node = list[0] as Record<string, unknown>;
      return;
    }
    if (isLast) {
      node[segment] = value;
      return;
    }
    if (!isPlainContainer(node[segment])) node[segment] = Object.create(null);
    node = node[segment] as Record<string, unknown>;
  });
}

function readNestedValue(root: unknown, name: string): unknown {
  const segments = name.split(".").filter(Boolean);
  let node: unknown = root;
  for (const [index, segment] of segments.entries()) {
    if (!isPlainContainer(node)) return undefined;
    const arrayKey = ARRAY_SEGMENT.exec(segment)?.[1];
    // Own keys only, so `constructor.name` does not read from a prototype.
    if (!Object.hasOwn(node, arrayKey ?? segment)) return undefined;
    if (!arrayKey) {
      node = node[segment];
      continue;
    }
    const list = node[arrayKey];
    if (!Array.isArray(list)) return undefined;
    if (index === segments.length - 1) return list;
    // The form shows one item of a list. More items stay in the JSON view.
    if (list.length > 1) return undefined;
    node = list[0];
  }
  return node;
}

function countLeaves(value: unknown): number {
  if (!isPlainContainer(value)) return 1;
  return Object.values(value).reduce<number>(
    (total, item) => total + countLeaves(item),
    0
  );
}

export type JsonToFieldsResult =
  | { ok: true; values: Record<string, string> }
  | { ok: false; reason: "invalid_json" | "unknown_fields" };

/**
 * The field values of a JSON body, for the switch from the JSON view to the
 * fields view. A field that the form does not show would be lost in the switch,
 * so that case stays in the JSON view.
 */
export function jsonBodyToFieldValues(
  text: string,
  parameters: readonly ApiParameterDefinition[]
): JsonToFieldsResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, values: {} };
  const parsed = parseJson(trimmed);
  if (!isPlainContainer(parsed)) return { ok: false, reason: "invalid_json" };

  const values: Record<string, string> = {};
  let mapped = 0;
  for (const parameter of parameters) {
    const value = readNestedValue(parsed, parameter.name);
    if (value === undefined) continue;
    mapped += countLeaves(value);
    values[parameter.name] =
      typeof value === "string" ? value : JSON.stringify(value);
  }
  return mapped === countLeaves(parsed)
    ? { ok: true, values }
    : { ok: false, reason: "unknown_fields" };
}

export function buildBrowserRequest(input: BrowserRequestInput): {
  url: string;
  init: RequestInit;
} {
  const request = buildPlaygroundRequest(input);

  // A browser cannot set a Cookie header. Only the proxy can send these.
  if (request.cookies.length > 0) {
    const auth = input.parameters.find(
      (parameter) =>
        isAuthParameter(parameter) && parameter.location === "cookie"
    );
    if (auth && input.token) {
      throw new Error(
        "Cookie authentication cannot be set by browser fetch. Authenticate with the API origin or copy the curl example instead."
      );
    }
    throw unsupportedCookieInputError(request.cookies[0]![0]);
  }

  const headers = new Headers();
  for (const [name, value] of request.headers) headers.append(name, value);

  return {
    url: buildRequestUrl(input.baseUrl, request).toString(),
    init: {
      method: request.method,
      headers,
      // A redirect must not carry a key to another host, and the docs site's
      // cookies have no part in a request to an API.
      redirect: "manual",
      credentials: "omit",
      ...(request.body ? { body: request.body.text } : {}),
    },
  };
}

/** The same request for the proxy. It names no host, so the server decides. */
export function buildTryRequest(
  input: BrowserRequestInput,
  targetId: string
): DocsTryRequest {
  const request = buildPlaygroundRequest(input);
  return {
    v: 1,
    targetId,
    method: request.method as DocsTryMethod,
    path: request.path,
    query: request.query,
    headers: request.headers,
    cookies: request.cookies,
    ...(request.body
      ? { body: { encoding: "utf8" as const, data: request.body.text } }
      : {}),
  };
}

export function buildRequestUrl(
  baseUrl: string,
  request: Pick<PlaygroundRequest, "path" | "query">
): URL {
  const url = resolveRequestUrl(baseUrl, request.path);
  for (const [name, value] of request.query) {
    url.searchParams.append(name, value);
  }
  return url;
}

/**
 * The endpoint URL: the endpoint path under the owner's base URL. The path
 * comes from page content, so it must never pick the host. With the base `/`,
 * the path `\evil.example/x` would make `/\evil.example/x`, which a browser
 * reads as `https://evil.example/x`. So leading slashes and backslashes are
 * removed from the path, and a URL on any origin other than the base's origin
 * is refused before a credential goes into it.
 */
function resolveRequestUrl(baseUrl: string, path: string): URL {
  const base = baseUrl.replace(/\/+$/, "");
  const url = createBrowserRequestUrl(`${base}/${path.replace(/^[\\/]+/, "")}`);
  if (url.origin !== createBrowserRequestUrl(base || "/").origin) {
    throw new Error(
      "The endpoint path points to another host than the API base URL, so the playground does not send it."
    );
  }
  return url;
}

function createBrowserRequestUrl(value: string): URL {
  return typeof window === "undefined"
    ? new URL(value)
    : new URL(value, window.location.origin);
}

function applyAuthorization(
  parameter: ApiParameterDefinition,
  token: string,
  query: [string, string][],
  headers: [string, string][],
  cookies: [string, string][]
): void {
  if (!token) return;
  switch (parameter.location) {
    case "header":
      headers.push([authHeaderName(parameter), authHeaderValue(parameter, token)]);
      return;
    case "query":
      query.push([authParameterName(parameter), token]);
      return;
    case "cookie":
      cookies.push([authParameterName(parameter), token]);
      return;
    case "path":
    case "body":
    case "response":
      throw new Error(
        `Unsupported authorization location: ${parameter.location}.`
      );
  }
}

function unsupportedCookieInputError(name: string): Error {
  return new Error(
    `Cookie parameter "${name}" cannot be set by browser fetch. Use the curl example instead.`
  );
}

/**
 * Old pages name an unnamed API key "API key", which is a label and not a
 * header. Published pages never change, so the reader handles it.
 */
function authHeaderName(parameter: ApiParameterDefinition): string {
  return HTTP_TOKEN.test(parameter.name)
    ? parameter.name
    : DEFAULT_API_KEY_HEADER;
}

function authParameterName(parameter: ApiParameterDefinition): string {
  return HTTP_TOKEN.test(parameter.name)
    ? parameter.name
    : DEFAULT_API_KEY_PARAMETER;
}

/** The fixed text that the panel shows before the key field. */
export function authValuePrefix(
  parameter: ApiParameterDefinition
): "Bearer" | "Basic" | null {
  if (parameter.location !== "header") return null;
  const type = parameter.type.toLowerCase();
  if (type === "bearer" || type === "oauth2") return "Bearer";
  return type === "basic" ? "Basic" : null;
}

function authHeaderValue(
  parameter: ApiParameterDefinition,
  token: string
): string {
  const prefix = authValuePrefix(parameter);
  if (prefix === "Bearer") return `Bearer ${token}`;
  if (prefix === "Basic") {
    return `Basic ${token.includes(":") ? encodeBasicCredentials(token) : token}`;
  }
  return token;
}

/** `btoa` takes Latin-1 only, and a password can hold any character. */
function encodeBasicCredentials(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
