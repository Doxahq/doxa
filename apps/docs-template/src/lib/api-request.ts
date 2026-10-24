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

export function authStorageKey(): string {
  return `doxa-api-token:${window.location.host}`;
}

export function loadSessionAuthToken(): string {
  return window.sessionStorage.getItem(authStorageKey()) ?? "";
}

export function saveSessionAuthToken(value: string): void {
  if (value) {
    window.sessionStorage.setItem(authStorageKey(), value);
    return;
  }
  window.sessionStorage.removeItem(authStorageKey());
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

  const url = createBrowserRequestUrl(
    `${input.baseUrl.replace(/\/+$/, "")}/${requestPath.replace(/^\/+/, "")}`
  );
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
