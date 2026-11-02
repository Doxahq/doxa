import { normalizeApiMethod } from "@/src/lib/api-reference";
import type { ApiParameterDefinition } from "@/src/lib/endpoint-document";

export type { ApiParameterDefinition };

export interface BrowserRequestInput {
  method: string;
  path: string;
  baseUrl: string;
  parameters: readonly ApiParameterDefinition[];
  values: Readonly<Record<string, string>>;
  token: string;
}

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

export function buildBrowserRequest(input: BrowserRequestInput): {
  url: string;
  init: RequestInit;
} {
  let requestPath = input.path;
  const query = new URLSearchParams();
  const headers = new Headers();
  const body: Record<string, string> = {};

  for (const parameter of input.parameters) {
    if (isAuthParameter(parameter)) {
      applyAuthorization(parameter, input.token, query, headers);
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
        query.set(parameter.name, value);
        break;
      case "header":
        headers.set(parameter.name, value);
        break;
      case "cookie":
        throw unsupportedCookieInputError(parameter.name);
      case "body":
        body[parameter.name] = value;
        break;
      case "response":
        break;
    }
  }

  const url = resolveRequestUrl(input.baseUrl, requestPath);
  for (const [name, value] of query) url.searchParams.set(name, value);
  const hasBody = Object.keys(body).length > 0;
  if (hasBody) headers.set("Content-Type", "application/json");

  return {
    url: url.toString(),
    init: {
      method: normalizeApiMethod(input.method) ?? "GET",
      headers,
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    },
  };
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
  query: URLSearchParams,
  headers: Headers
): void {
  if (!token) return;
  switch (parameter.location) {
    case "header":
      headers.set(parameter.name, authHeaderValue(parameter, token));
      return;
    case "query":
      query.set(parameter.name, token);
      return;
    case "cookie":
      throw new Error(
        "Cookie authentication cannot be set by browser fetch. Authenticate with the API origin or copy the curl example instead."
      );
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

function authHeaderValue(
  parameter: ApiParameterDefinition,
  token: string
): string {
  return ["bearer", "oauth2"].includes(parameter.type.toLowerCase())
    ? `Bearer ${token}`
    : token;
}
