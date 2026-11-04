import type { RestApiReferenceSurface } from "../types";
import { normalizeProjectAnalysis } from "../utils/analysis-normalizer";
import {
  REST_REQUEST_CLIENT_IDS,
  type RestRequestClientId,
} from "./rest-request-samples";

export interface RestApiPageTitles {
  readonly auth: string;
  readonly path: string;
  readonly query: string;
  readonly header: string;
  readonly body: string;
  readonly response: string;
}
export interface RestApiDocsPolicy {
  readonly overviewPage: {
    readonly enabled: boolean;
    readonly id: string;
    readonly title: string;
  };
  readonly authPage: {
    readonly enabled: boolean;
    readonly id: string;
    readonly title: string;
    readonly linkText: string;
  };
  readonly groupPages: { readonly enabled: boolean };
  readonly playground: { readonly mode: "auto" | "always" | "never" };
  readonly paramGroupTitles: RestApiPageTitles;
  readonly requestClients: readonly RestRequestClientId[];
}

type RestApiPlaygroundMode = RestApiDocsPolicy["playground"]["mode"];

export const DEFAULT_REST_API_DOCS_POLICY: RestApiDocsPolicy = freezePolicy({
  overviewPage: {
    enabled: true,
    id: "index",
    title: "REST API",
  },
  authPage: {
    enabled: true,
    id: "authentication",
    title: "Authentication",
    linkText: "Authentication",
  },
  groupPages: { enabled: true },
  playground: { mode: "auto" },
  paramGroupTitles: {
    auth: "Authentication",
    path: "Path Parameters",
    query: "Query Parameters",
    header: "Header Parameters",
    body: "Body",
    response: "Response",
  },
  requestClients: REST_REQUEST_CLIENT_IDS,
});

export function resolveRestApiDocsPolicy(
  answers: Record<string, unknown>,
): RestApiDocsPolicy {
  const restApi = asRecord(answers.restApi);

  return freezePolicy({
    overviewPage: resolvePage(restApi?.overviewPage, DEFAULT_REST_API_DOCS_POLICY.overviewPage),
    authPage: resolveAuthPage(restApi?.authPage),
    groupPages: {
      enabled: readBoolean(
        asRecord(restApi?.groupPages)?.enabled,
        DEFAULT_REST_API_DOCS_POLICY.groupPages.enabled,
      ),
    },
    playground: {
      mode: readPlaygroundMode(
        asRecord(restApi?.playground)?.mode,
        DEFAULT_REST_API_DOCS_POLICY.playground.mode,
      ),
    },
    paramGroupTitles: resolveParamGroupTitles(restApi?.paramGroupTitles),
    requestClients: resolveRequestClients(restApi, restApi?.requestClients),
  });
}

export function isRestApiPlaygroundEnabled(
  surface: RestApiReferenceSurface | undefined,
  policy: RestApiDocsPolicy,
): boolean {
  if (policy.playground.mode === "never") return false;
  if (surface?.playground?.enabled === false) return false;
  if (policy.playground.mode === "always") return true;
  return playgroundServerUrl(surface) !== undefined;
}

/**
 * The first server URL that the playground may call: `https:`, a public DNS
 * name, and no user name or password. An IP address, `localhost`, a
 * single-label host and the reserved local names never qualify. The same rules
 * apply to the proxy (`parseDocsTryTarget`) and to the reader's browser, so the
 * docs cannot point either of them at a private network.
 */
export function playgroundServerUrl(surface: RestApiReferenceSurface | undefined): string | undefined {
  return [surface?.baseUrl, ...(surface?.servers ?? [])]
    .map((url) => url?.trim())
    .find((url): url is string => Boolean(url) && isPublicHttpsUrl(url!));
}

const LOCAL_HOST_SUFFIX = /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|test|invalid|onion)$/;
const IP_ADDRESS_HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/;

function isPublicHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    host.includes(".") &&
    !IP_ADDRESS_HOST.test(host) &&
    !LOCAL_HOST_SUFFIX.test(host);
}

export function resolveRestApiRuntimeFeatures(
  analysis: unknown,
  answers: Record<string, unknown> = {},
): { readonly apiPlayground: boolean } {
  const surface = normalizeProjectAnalysis(analysis).referenceSurfaces?.rest;
  const policy = resolveRestApiDocsPolicy(answers);
  return {
    apiPlayground:
      policy.playground.mode !== "never" &&
      surface?.playground?.enabled !== false,
  };
}

function resolvePage(
  value: unknown,
  fallback: RestApiDocsPolicy["overviewPage"],
): RestApiDocsPolicy["overviewPage"] {
  const page = asRecord(value);
  return {
    enabled: readBoolean(page?.enabled, fallback.enabled),
    id: readNonEmptyString(page?.id, fallback.id),
    title: readNonEmptyString(page?.title, fallback.title),
  };
}

function resolveAuthPage(value: unknown): RestApiDocsPolicy["authPage"] {
  const page = asRecord(value);
  const fallback = DEFAULT_REST_API_DOCS_POLICY.authPage;
  return {
    enabled: readBoolean(page?.enabled, fallback.enabled),
    id: readNonEmptyString(page?.id, fallback.id),
    title: readNonEmptyString(page?.title, fallback.title),
    linkText: readNonEmptyString(page?.linkText, fallback.linkText),
  };
}

function resolveParamGroupTitles(value: unknown): RestApiPageTitles {
  const titles = asRecord(value);
  const fallback = DEFAULT_REST_API_DOCS_POLICY.paramGroupTitles;
  return {
    auth: readNonEmptyString(titles?.auth, fallback.auth),
    path: readNonEmptyString(titles?.path, fallback.path),
    query: readNonEmptyString(titles?.query, fallback.query),
    header: readNonEmptyString(titles?.header, fallback.header),
    body: readNonEmptyString(titles?.body, fallback.body),
    response: readNonEmptyString(titles?.response, fallback.response),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readNonEmptyString(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  return value.trim() || fallback;
}

function readPlaygroundMode(
  value: unknown,
  fallback: RestApiPlaygroundMode,
): RestApiPlaygroundMode {
  return value === "auto" || value === "always" || value === "never"
    ? value
    : fallback;
}

function resolveRequestClients(
  restApi: Record<string, unknown> | undefined,
  value: unknown,
): readonly RestRequestClientId[] {
  if (!restApi || !("requestClients" in restApi)) {
    return DEFAULT_REST_API_DOCS_POLICY.requestClients;
  }

  if (!Array.isArray(value)) return ["curl"];

  const knownClients = new Set<unknown>(REST_REQUEST_CLIENT_IDS);
  const clients = value.filter(
    (client): client is RestRequestClientId => knownClients.has(client),
  );
  const uniqueClients = [...new Set(clients)];
  return uniqueClients.length > 0 ? uniqueClients : ["curl"];
}

function freezePolicy(policy: RestApiDocsPolicy): RestApiDocsPolicy {
  Object.freeze(policy.overviewPage);
  Object.freeze(policy.authPage);
  Object.freeze(policy.groupPages);
  Object.freeze(policy.playground);
  Object.freeze(policy.paramGroupTitles);
  Object.freeze(policy.requestClients);
  return Object.freeze(policy);
}
