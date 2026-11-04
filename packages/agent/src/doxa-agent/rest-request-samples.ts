import type {
  RestApiReferenceAuth,
  RestApiReferenceEndpoint,
  RestApiReferenceField,
} from "../types";
import { exampleFromFields, type JsonExampleValue } from "./rest-json-example";

export const REST_REQUEST_CLIENT_IDS = [
  "curl",
  "node-fetch",
  "node-xhr",
  "python-requests",
  "python-httpx",
  "go",
] as const;

export type RestRequestClientId = (typeof REST_REQUEST_CLIENT_IDS)[number];

export interface RestRequestHeader {
  readonly name: string;
  readonly value: string;
}

export interface RestRequestBody {
  readonly contentType: string;
  readonly fields: readonly RestApiReferenceField[];
}

export interface RestRequestModel {
  readonly method: string;
  readonly url: string;
  readonly headers: readonly RestRequestHeader[];
  readonly body?: RestRequestBody;
}

export interface RestRequestSample {
  readonly client: RestRequestClientId;
  readonly lang: string;
  readonly code: string;
}

export function buildRestRequestModel(
  endpoint: RestApiReferenceEndpoint,
  baseUrl: string,
): RestRequestModel {
  const query = [
    ...authorizationQuery(endpoint.authRequirement),
    ...(endpoint.parameters ?? [])
      .filter((parameter) => parameter.in === "query")
      .map((parameter) => ({ name: parameter.name, value: parameter.example ?? `<${parameter.type}>` })),
  ].map(({ name, value }) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
  const body = endpoint.bodyFields?.length
    ? {
        contentType: endpoint.bodyContentType ?? "application/json",
        fields: endpoint.bodyFields,
      }
    : undefined;
  const headers = requestHeaders(endpoint);

  return {
    method: endpoint.method.toUpperCase(),
    url: `${joinUrl(baseUrl, endpoint.path)}${query.length ? `?${query.join("&")}` : ""}`,
    headers: body
      ? [...headers, { name: "Content-Type", value: body.contentType }]
      : headers,
    ...(body ? { body } : {}),
  };
}

export function buildRestRequestSample(
  client: RestRequestClientId,
  model: RestRequestModel,
): RestRequestSample {
  const generators: Record<
    RestRequestClientId,
    (request: RestRequestModel) => string
  > = {
    curl: buildCurlSample,
    "node-fetch": buildNodeFetchSample,
    "node-xhr": buildNodeXhrSample,
    "python-requests": (request) => buildPythonSample("requests", request),
    "python-httpx": (request) => buildPythonSample("httpx", request),
    go: buildGoSample,
  };
  const languages: Record<RestRequestClientId, string> = {
    curl: "bash",
    "node-fetch": "js",
    "node-xhr": "js",
    "python-requests": "python",
    "python-httpx": "python",
    go: "go",
  };

  return {
    client,
    lang: languages[client],
    code: generators[client](model),
  };
}

function buildCurlSample(model: RestRequestModel): string {
  const lines = [
    `curl --request ${model.method} \\`,
    `  --url ${quoteShell(model.url)}`,
  ];

  for (const header of model.headers) {
    lines[lines.length - 1] = `${lines.at(-1)} \\`;
    lines.push(`  --header ${quoteShell(`${header.name}: ${header.value}`)}`);
  }

  if (model.body) {
    lines[lines.length - 1] = `${lines.at(-1)} \\`;
    lines.push(`  --data ${quoteShell(compactJsonExample(model.body.fields))}`);
  }

  return lines.join("\n");
}

function buildNodeFetchSample(model: RestRequestModel): string {
  const optionLines = [`  method: ${quoteJavaScript(model.method)}`];

  if (model.headers.length) {
    optionLines[optionLines.length - 1] += ",";
    optionLines.push("  headers: {");
    optionLines.push(
      ...model.headers.map(
        (header, index) =>
          `    ${quoteJavaScript(header.name)}: ${quoteJavaScript(header.value)}${
            index < model.headers.length - 1 ? "," : ""
          }`,
      ),
    );
    optionLines.push(model.body ? "  }," : "  }");
  } else if (model.body) {
    optionLines[optionLines.length - 1] += ",";
  }

  if (model.body) {
    optionLines.push(
      `  body: JSON.stringify(${compactJsonExample(model.body.fields)})`,
    );
  }

  return [
    `const response = await fetch(${quoteJavaScript(model.url)}, {`,
    ...optionLines,
    "});",
    "",
    "const data = await response.json();",
    "console.log(data);",
  ].join("\n");
}

function buildNodeXhrSample(model: RestRequestModel): string {
  const lines = [
    // Node has no XMLHttpRequest of its own.
    'const XMLHttpRequest = require("xhr2");',
    "",
    "const xhr = new XMLHttpRequest();",
    `xhr.open(${quoteJavaScript(model.method)}, ${quoteJavaScript(model.url)});`,
    ...model.headers.map(
      (header) =>
        `xhr.setRequestHeader(${quoteJavaScript(header.name)}, ${quoteJavaScript(header.value)});`,
    ),
    "",
    "xhr.onload = () => console.log(xhr.responseText);",
    model.body
      ? `xhr.send(JSON.stringify(${compactJsonExample(model.body.fields)}));`
      : "xhr.send();",
  ];

  return lines.join("\n");
}

type PythonClient = "requests" | "httpx";

function buildPythonSample(
  client: PythonClient,
  model: RestRequestModel,
): string {
  const lines = [`import ${client}`, "", `url = ${quotePython(model.url)}`];

  if (model.headers.length) {
    lines.push("headers = {");
    lines.push(
      ...model.headers.map(
        (header, index) =>
          `    ${quotePython(header.name)}: ${quotePython(header.value)}${
            index < model.headers.length - 1 ? "," : ""
          }`,
      ),
    );
    lines.push("}");
  }

  if (model.body) {
    lines.push(`payload = ${pythonObject(model.body.fields)}`);
  }

  lines.push("");
  const args = ["url"];
  if (model.headers.length) args.push("headers=headers");
  if (model.body) args.push("json=payload");
  const helper = pythonMethodHelper(model.method);
  const call = helper
    ? `${client}.${helper}(${args.join(", ")})`
    : `${client}.request(${quotePython(model.method)}, ${args.join(", ")})`;
  lines.push(`response = ${call}`, "print(response.json())");

  return lines.join("\n");
}

function buildGoSample(model: RestRequestModel): string {
  const imports = [
    ...(model.body ? ['\t"bytes"'] : []),
    '\t"fmt"',
    '\t"io"',
    '\t"net/http"',
  ];
  const requestBody = model.body ? "bytes.NewBuffer(payload)" : "nil";
  const lines = [
    "package main",
    "",
    "import (",
    ...imports,
    ")",
    "",
    "func main() {",
    `\turl := ${quoteGo(model.url)}`,
  ];

  if (model.body) {
    lines.push(
      `\tpayload := []byte(${goPayloadLiteral(compactJsonExample(model.body.fields))})`,
    );
  }

  lines.push(
    "",
    `\treq, _ := http.NewRequest(${quoteGo(model.method)}, url, ${requestBody})`,
    ...model.headers.map(
      (header) =>
        `\treq.Header.Set(${quoteGo(header.name)}, ${quoteGo(header.value)})`,
    ),
    "",
    "\tres, err := http.DefaultClient.Do(req)",
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    "\tdefer res.Body.Close()",
    "",
    "\tbody, _ := io.ReadAll(res.Body)",
    "\tfmt.Println(string(body))",
    "}",
  );

  return lines.join("\n");
}

function requestHeaders(
  endpoint: RestApiReferenceEndpoint,
): RestRequestHeader[] {
  const headers = (endpoint.parameters ?? [])
    .filter((parameter) => parameter.in === "header")
    .map((parameter) => ({
      name: parameter.name,
      value: parameter.example ?? `<${parameter.type}>`,
    }));
  const authHeader = authorizationHeader(endpoint.authRequirement);
  return authHeader ? [authHeader, ...headers] : headers;
}

/**
 * The header that sends the credential. Bearer, Basic and OAuth 2 tokens
 * always go in `Authorization`, whether or not the source named a
 * location. An API key goes where the source says: a named header, or a
 * cookie; a query key goes in the URL instead.
 */
function authorizationHeader(
  auth: RestApiReferenceAuth | undefined,
): RestRequestHeader | undefined {
  if (!auth) return undefined;
  switch (auth.scheme) {
    case "none":
      return undefined;
    case "bearer":
      return { name: "Authorization", value: "Bearer <token>" };
    case "basic":
      return { name: "Authorization", value: "Basic <credentials>" };
    case "oauth2":
      return { name: "Authorization", value: "Bearer <access-token>" };
    case "apiKey":
      if (auth.location === "cookie") return { name: "Cookie", value: `${auth.name ?? "api_key"}=<api-key>` };
      return auth.location === "query" ? undefined : { name: auth.name ?? "X-API-Key", value: "<api-key>" };
  }
}

/** An API key that the source sends as a query parameter. */
function authorizationQuery(auth: RestApiReferenceAuth | undefined): RestRequestHeader[] {
  return auth?.scheme === "apiKey" && auth.location === "query"
    ? [{ name: auth.name ?? "api_key", value: "<api-key>" }]
    : [];
}

function pythonMethodHelper(method: string): string | undefined {
  const helper = method.toLowerCase();
  return new Set([
    "get",
    "options",
    "head",
    "post",
    "put",
    "patch",
    "delete",
  ]).has(helper)
    ? helper
    : undefined;
}

function pythonObject(fields: readonly RestApiReferenceField[]): string {
  return pythonLiteral(exampleFromFields(fields));
}

/** A Python literal of a JSON example value. */
function pythonLiteral(value: JsonExampleValue): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return quotePython(value);
  if (Array.isArray(value)) return `[${value.map(pythonLiteral).join(", ")}]`;
  return `{${Object.entries(value).map(([key, entry]) => `${quotePython(key)}: ${pythonLiteral(entry)}`).join(", ")}}`;
}

function compactJsonExample(fields: readonly RestApiReferenceField[]): string {
  return JSON.stringify(exampleFromFields(fields));
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Other control characters and line separators, which a string literal must not hold raw. */
const UNSAFE_LITERAL_CHARACTERS = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g;

function unicodeEscape(character: string): string {
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

/** A POSIX single-quoted word. A shell argument cannot hold NUL, so it is dropped. */
function quoteShell(value: string): string {
  return `'${value.replace(/\0/g, "").replace(/'/g, `'"'"'`)}'`;
}

function quoteJavaScript(value: string): string {
  return `'${value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(UNSAFE_LITERAL_CHARACTERS, unicodeEscape)}'`;
}

function quotePython(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(UNSAFE_LITERAL_CHARACTERS, unicodeEscape)}"`;
}

function quoteGo(value: string): string {
  return JSON.stringify(value);
}

function goPayloadLiteral(json: string): string {
  return json.includes("`") ? quoteGo(json) : `\`${json}\``;
}
