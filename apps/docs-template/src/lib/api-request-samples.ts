import {
  buildPlaygroundRequest,
  buildRequestUrl,
  type BrowserRequestInput,
  type PlaygroundRequest,
} from "@/src/lib/api-request";

/** Stands for the key in a sample. A sample never holds the real value. */
export const SAMPLE_SECRET = "$API_KEY";
const ENCODED_SAMPLE_SECRET = encodeURIComponent(SAMPLE_SECRET);

export const LIVE_SAMPLE_CLIENTS = [
  { client: "curl", language: "bash" },
  { client: "node-fetch", language: "javascript" },
  { client: "node-xhr", language: "javascript" },
  { client: "python-requests", language: "python" },
  { client: "python-httpx", language: "python" },
  { client: "go", language: "go" },
] as const;

export type LiveSampleClient = (typeof LIVE_SAMPLE_CLIENTS)[number]["client"];

export function isLiveSampleClient(value: string | null): value is LiveSampleClient {
  return LIVE_SAMPLE_CLIENTS.some((entry) => entry.client === value);
}

/**
 * The request as code, from the values in the panel. Readers copy this into a
 * shell or a ticket, so the key is always a placeholder. Page content can name
 * parameters, so every value is quoted as data.
 */
export function buildLiveSample(
  client: LiveSampleClient,
  input: Omit<BrowserRequestInput, "token">
): string {
  const request = withWellFormedText(
    buildPlaygroundRequest({ ...input, token: SAMPLE_SECRET })
  );
  const url = buildRequestUrl(input.baseUrl, request)
    .toString()
    .split(ENCODED_SAMPLE_SECRET)
    .join(SAMPLE_SECRET);
  switch (client) {
    case "curl":
      return curlSample(request, url);
    case "node-fetch":
      return fetchSample(request, url);
    case "node-xhr":
      return xhrSample(request, url);
    case "python-requests":
      return pythonSample("requests", request, url);
    case "python-httpx":
      return pythonSample("httpx", request, url);
    case "go":
      return goSample(request, url);
  }
}

/** With the `u` flag, this matches only a surrogate that has no pair. */
const LONE_SURROGATE = /\p{Surrogate}/gu;

function wellFormed(value: string): string {
  return value.replace(LONE_SURROGATE, "\uFFFD");
}

function wellFormedPairs(pairs: readonly [string, string][]): [string, string][] {
  return pairs.map(([name, value]) => [wellFormed(name), wellFormed(value)]);
}

/** Go refuses a string with half of a surrogate pair, so a sample holds none. */
function withWellFormedText(request: PlaygroundRequest): PlaygroundRequest {
  return {
    ...request,
    headers: wellFormedPairs(request.headers),
    cookies: wellFormedPairs(request.cookies),
    ...(request.body
      ? { body: { ...request.body, text: wellFormed(request.body.text) } }
      : {}),
  };
}

function cookieHeaderValue(request: PlaygroundRequest): string | null {
  return request.cookies.length > 0
    ? request.cookies.map(([name, value]) => `${name}=${value}`).join("; ")
    : null;
}

const SHELL_SAFE = /^[A-Za-z0-9 :_\-./=&?%+,@~]*$/;

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Only `$API_KEY` may expand in the reader's shell. Text around it stays in
 * single quotes unless it holds no character that a shell treats as special.
 */
function shellQuote(value: string): string {
  if (!value.includes(SAMPLE_SECRET)) return shellSingleQuote(value);
  const parts = value.split(SAMPLE_SECRET);
  if (parts.every((part) => SHELL_SAFE.test(part))) return `"${value}"`;
  return parts
    .map((part) => (part ? shellSingleQuote(part) : ""))
    .join(`"${SAMPLE_SECRET}"`);
}

function curlSample(request: PlaygroundRequest, url: string): string {
  const lines = [`curl --request ${request.method}`, `--url ${shellQuote(url)}`];
  for (const [name, value] of request.headers) {
    lines.push(`--header ${shellQuote(`${name}: ${value}`)}`);
  }
  const cookies = cookieHeaderValue(request);
  if (cookies) lines.push(`--cookie ${shellQuote(cookies)}`);
  if (request.body) lines.push(`--data ${shellQuote(request.body.text)}`);
  return lines.join(" \\\n  ");
}

/** A string literal, with the placeholder as a read of the environment. */
function codeString(value: string, secretExpression: string): string {
  return value
    .split(SAMPLE_SECRET)
    .map((part, index) =>
      index === 0
        ? part
          ? JSON.stringify(part)
          : ""
        : [secretExpression, ...(part ? [JSON.stringify(part)] : [])].join(" + ")
    )
    .filter(Boolean)
    .join(" + ");
}

function headerLines(
  request: PlaygroundRequest,
  secretExpression: string,
  indent: string,
  separator: string
): string[] {
  const cookies = cookieHeaderValue(request);
  const headers: [string, string][] = [
    ...request.headers,
    ...(cookies ? ([["Cookie", cookies]] as [string, string][]) : []),
  ];
  return headers.map(
    ([name, value]) =>
      `${indent}${JSON.stringify(name)}${separator}${codeString(value, secretExpression)},`
  );
}

function fetchSample(request: PlaygroundRequest, url: string): string {
  const secret = "process.env.API_KEY";
  const headers = headerLines(request, secret, "    ", ": ");
  return [
    `const response = await fetch(${codeString(url, secret)}, {`,
    `  method: ${JSON.stringify(request.method)},`,
    ...(headers.length > 0 ? ["  headers: {", ...headers, "  },"] : []),
    ...(request.body ? [`  body: ${JSON.stringify(request.body.text)},`] : []),
    "});",
    "",
    "console.log(response.status, await response.text());",
  ].join("\n");
}

function xhrSample(request: PlaygroundRequest, url: string): string {
  const secret = "process.env.API_KEY";
  const cookies = cookieHeaderValue(request);
  const headers: [string, string][] = [
    ...request.headers,
    ...(cookies ? ([["Cookie", cookies]] as [string, string][]) : []),
  ];
  return [
    'const XMLHttpRequest = require("xhr2");',
    "",
    "const xhr = new XMLHttpRequest();",
    `xhr.open(${JSON.stringify(request.method)}, ${codeString(url, secret)});`,
    ...headers.map(
      ([name, value]) =>
        `xhr.setRequestHeader(${JSON.stringify(name)}, ${codeString(value, secret)});`
    ),
    "",
    "xhr.onload = () => console.log(xhr.status, xhr.responseText);",
    `xhr.send(${request.body ? JSON.stringify(request.body.text) : ""});`,
  ].join("\n");
}

function usesSampleSecret(request: PlaygroundRequest, url: string): boolean {
  return [url, ...request.headers.map(([, value]) => value)]
    .concat(cookieHeaderValue(request) ?? "")
    .some((value) => value.includes(SAMPLE_SECRET));
}

function goSample(request: PlaygroundRequest, url: string): string {
  const secret = 'os.Getenv("API_KEY")';
  const cookies = cookieHeaderValue(request);
  const headers: [string, string][] = [
    ...request.headers,
    ...(cookies ? ([["Cookie", cookies]] as [string, string][]) : []),
  ];
  const imports = [
    "fmt",
    "io",
    "net/http",
    ...(usesSampleSecret(request, url) ? ["os"] : []),
    ...(request.body ? ["strings"] : []),
  ];
  const body = request.body
    ? `strings.NewReader(${JSON.stringify(request.body.text)})`
    : "nil";
  return [
    "package main",
    "",
    "import (",
    ...imports.map((name) => `\t${JSON.stringify(name)}`),
    ")",
    "",
    "func main() {",
    `\treq, err := http.NewRequest(${JSON.stringify(request.method)}, ${codeString(url, secret)}, ${body})`,
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    ...headers.map(
      ([name, value]) =>
        `\treq.Header.Set(${JSON.stringify(name)}, ${codeString(value, secret)})`
    ),
    "",
    "\tres, err := http.DefaultClient.Do(req)",
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    "\tdefer res.Body.Close()",
    "",
    "\tanswer, _ := io.ReadAll(res.Body)",
    "\tfmt.Println(res.StatusCode, string(answer))",
    "}",
  ].join("\n");
}

function pythonSample(
  library: "requests" | "httpx",
  request: PlaygroundRequest,
  url: string
): string {
  const secret = 'os.environ["API_KEY"]';
  const headers = headerLines(request, secret, "        ", ": ");
  // The two libraries name the raw body differently.
  const bodyArgument = library === "requests" ? "data" : "content";
  return [
    ...(usesSampleSecret(request, url) ? ["import os", ""] : []),
    `import ${library}`,
    "",
    `response = ${library}.request(`,
    `    ${JSON.stringify(request.method)},`,
    `    ${codeString(url, secret)},`,
    ...(headers.length > 0 ? ["    headers={", ...headers, "    },"] : []),
    ...(request.body ? [`    ${bodyArgument}=${JSON.stringify(request.body.text)},`] : []),
    ")",
    "",
    "print(response.status_code, response.text)",
  ].join("\n");
}
