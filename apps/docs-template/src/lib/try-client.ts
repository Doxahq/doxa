import {
  DOCS_TRY_CONFIG_PATH,
  DOCS_TRY_CONTENT_TYPE,
  DOCS_TRY_LIMITS,
  DOCS_TRY_PATH,
  DOCS_TRY_RESULT_HEADER,
  decodeDocsTryResult,
  type DocsTryConfig,
  type DocsTryProblem,
  type DocsTryProblemCode,
  type DocsTryRequest,
} from "@doxahq/contracts/docs-try";

/** The panel shows this much of a text body. The whole body can be saved. */
const DISPLAY_TEXT_BYTES = 256 * 1024;
const PROGRESS_INTERVAL_MS = 150;

export interface PlaygroundAnswer {
  kind: "answer";
  via: "proxy" | "browser";
  status: number;
  statusText: string;
  elapsedMs: number;
  headers: [string, string][];
  headersTruncated: boolean;
  redirect?: { location: string | null; sameTarget: boolean };
  contentType: string | null;
  /** Null when the body is binary. */
  text: string | null;
  bytes: number;
  raw: Uint8Array | null;
  /** The body is still arriving. */
  streaming: boolean;
  textCut: boolean;
  stoppedBy: "size" | "time" | "reader" | null;
}

/** Doxa stopped the request before it sent it. */
export interface PlaygroundRefusal {
  kind: "refused";
  code: DocsTryProblemCode | null;
  title: string;
  retryAfter?: number;
}

/** The request did not get an answer. */
export interface PlaygroundFailure {
  kind: "failed";
  code: DocsTryProblemCode | null;
  title: string;
  detail?: string;
  /** True or false when known. Null when nobody can tell. */
  keyLeftDoxa: boolean | null;
}

export type PlaygroundOutcome =
  | PlaygroundAnswer
  | PlaygroundRefusal
  | PlaygroundFailure;

export interface PlaygroundSendOptions {
  signal: AbortSignal;
  onProgress?: (answer: PlaygroundAnswer) => void;
}

const BROWSER_FALLBACK: DocsTryConfig = { mode: "browser", reason: "proxy_off" };

/**
 * How this site sends requests. It is not in the page, so a change applies at
 * once and the panel always names the real destination. A docs host with no
 * proxy route (local dev, an old dispatcher) falls back to the browser.
 */
export async function loadTryConfig(
  signal?: AbortSignal
): Promise<DocsTryConfig> {
  try {
    const response = await fetch(DOCS_TRY_CONFIG_PATH, {
      cache: "no-store",
      credentials: "omit",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return BROWSER_FALLBACK;
    const config = (await response.json()) as DocsTryConfig;
    return ["proxy", "browser", "off"].includes(config?.mode)
      ? config
      : BROWSER_FALLBACK;
  } catch {
    return BROWSER_FALLBACK;
  }
}

export async function sendThroughDoxa(
  request: DocsTryRequest,
  options: PlaygroundSendOptions
): Promise<PlaygroundOutcome> {
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(DOCS_TRY_PATH, {
      method: "POST",
      headers: { "content-type": DOCS_TRY_CONTENT_TYPE },
      body: JSON.stringify(request),
      // The route never uses them, so the docs site's cookies stay out of it.
      credentials: "omit",
      cache: "no-store",
      signal: options.signal,
    });
  } catch (error) {
    if (isAbort(error)) return canceled(null);
    return {
      kind: "failed",
      code: null,
      title: "This browser could not reach Doxa.",
      detail: "Check your network connection, then try again.",
      keyLeftDoxa: false,
    };
  }

  const encoded = response.headers.get(DOCS_TRY_RESULT_HEADER);
  const result = encoded ? decodeDocsTryResult(encoded) : null;
  if (!result) return readRefusal(response);

  const contentType = headerValue(result.headers, "content-type");
  const totalMs = contentType?.toLowerCase().startsWith("text/event-stream")
    ? DOCS_TRY_LIMITS.eventStreamTotalMs
    : DOCS_TRY_LIMITS.totalMs;
  return readAnswer(
    response,
    {
      via: "proxy",
      status: result.status,
      statusText: result.statusText,
      elapsedMs: result.elapsedMs,
      headers: result.headers,
      headersTruncated: result.headersTruncated,
      ...(result.redirect ? { redirect: result.redirect } : {}),
      contentType,
    },
    options,
    () => (Date.now() - startedAt >= totalMs ? "time" : null)
  );
}

export async function sendFromBrowser(
  request: { url: string; init: RequestInit },
  options: PlaygroundSendOptions
): Promise<PlaygroundOutcome> {
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(request.url, { ...request.init, signal: options.signal });
  } catch (error) {
    if (isAbort(error)) return canceled(null);
    return {
      kind: "failed",
      code: null,
      title: "The browser could not finish this request.",
      detail:
        "The API may be down, or it may not allow requests from this docs site (CORS). A browser does not say which. Try the cURL sample to check the API.",
      keyLeftDoxa: null,
    };
  }

  const elapsedMs = Date.now() - startedAt;
  const opaqueRedirect = response.type === "opaqueredirect";
  return readAnswer(
    response,
    {
      via: "browser",
      status: response.status,
      statusText: opaqueRedirect ? "Redirect" : response.statusText,
      elapsedMs,
      headers: [...response.headers],
      headersTruncated: false,
      // A browser hides where a manual redirect goes.
      ...(opaqueRedirect ? { redirect: { location: null, sameTarget: false } } : {}),
      contentType: response.headers.get("content-type"),
    },
    options,
    () => null
  );
}

type AnswerHead = Pick<
  PlaygroundAnswer,
  | "via"
  | "status"
  | "statusText"
  | "elapsedMs"
  | "headers"
  | "headersTruncated"
  | "redirect"
  | "contentType"
>;

const TEXT_CONTENT_TYPE =
  /^(?:text\/|image\/svg\+xml|application\/(?:[\w.+-]*\+)?(?:json|xml|yaml|x-yaml|javascript|x-www-form-urlencoded|graphql|sql|problem)\b)/i;

/** Only a known text type shows as text. Unknown bytes must not reach the DOM as text. */
function isTextBody(contentType: string | null, bytes: Uint8Array): boolean {
  if (contentType) return TEXT_CONTENT_TYPE.test(contentType.trim());
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

async function readAnswer(
  response: Response,
  head: AnswerHead,
  options: PlaygroundSendOptions,
  timeLimitReached: () => "time" | null
): Promise<PlaygroundOutcome> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let stoppedBy: PlaygroundAnswer["stoppedBy"] = null;
  let lastProgressAt = 0;
  const snapshot = (streaming: boolean): PlaygroundAnswer =>
    toAnswer(head, chunks, bytes, streaming, stoppedBy);

  const reader = response.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const room = DOCS_TRY_LIMITS.responseBytes - bytes;
        const chunk = value.byteLength > room ? value.slice(0, room) : value;
        chunks.push(chunk);
        bytes += chunk.byteLength;
        if (bytes >= DOCS_TRY_LIMITS.responseBytes) {
          stoppedBy = "size";
          await reader.cancel();
          break;
        }
        if (options.onProgress && Date.now() - lastProgressAt >= PROGRESS_INTERVAL_MS) {
          lastProgressAt = Date.now();
          options.onProgress(snapshot(true));
        }
      }
      stoppedBy ??= timeLimitReached();
    } catch (error) {
      if (!isAbort(error)) {
        return {
          kind: "failed",
          code: null,
          title: "The connection closed before the whole response arrived.",
          keyLeftDoxa: true,
        };
      }
      stoppedBy = "reader";
    }
  }
  return snapshot(false);
}

function toAnswer(
  head: AnswerHead,
  chunks: readonly Uint8Array[],
  bytes: number,
  streaming: boolean,
  stoppedBy: PlaygroundAnswer["stoppedBy"]
): PlaygroundAnswer {
  const raw = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = isTextBody(head.contentType, raw)
    ? new TextDecoder().decode(raw.subarray(0, DISPLAY_TEXT_BYTES))
    : null;
  return {
    kind: "answer",
    ...head,
    text,
    bytes,
    raw: bytes > 0 ? raw : null,
    streaming,
    textCut: text !== null && bytes > DISPLAY_TEXT_BYTES,
    stoppedBy,
  };
}

const CONNECTION_FAILURES = new Set<DocsTryProblemCode>([
  "target_dns",
  "target_tls",
  "target_refused",
  "target_timeout",
]);

async function readRefusal(response: Response): Promise<PlaygroundOutcome> {
  const problem = await readProblem(response);
  if (problem) {
    if (CONNECTION_FAILURES.has(problem.code)) {
      return {
        kind: "failed",
        code: problem.code,
        title: problem.title,
        keyLeftDoxa: keyLeftForFailure(problem.code),
      };
    }
    return {
      kind: "refused",
      code: problem.code,
      title: problem.title,
      ...(problem.retryAfter ? { retryAfter: problem.retryAfter } : {}),
    };
  }
  // The gateway limit answers before the route, as plain text.
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    return {
      kind: "refused",
      code: "rate_limited",
      title: "Too many requests. Wait, then try again.",
      ...(retryAfter > 0 ? { retryAfter } : {}),
    };
  }
  return {
    kind: "failed",
    code: null,
    title: "Doxa could not send this request.",
    detail: `The docs site answered with status ${response.status}.`,
    keyLeftDoxa: false,
  };
}

/**
 * A failed name lookup or TLS handshake comes before the request. A timeout
 * comes after it. A lost connection can come before or after, so nobody can say.
 */
function keyLeftForFailure(code: DocsTryProblemCode): boolean | null {
  if (code === "target_timeout") return true;
  return code === "target_refused" ? null : false;
}

async function readProblem(response: Response): Promise<DocsTryProblem | null> {
  if (!response.headers.get("content-type")?.includes("json")) return null;
  try {
    const value = (await response.json()) as Partial<DocsTryProblem>;
    return typeof value.code === "string" && typeof value.title === "string"
      ? (value as DocsTryProblem)
      : null;
  } catch {
    return null;
  }
}

function canceled(code: DocsTryProblemCode | null): PlaygroundFailure {
  return {
    kind: "failed",
    code,
    title: "You canceled this request.",
    keyLeftDoxa: null,
  };
}

function headerValue(
  headers: readonly [string, string][],
  name: string
): string | null {
  return (
    headers.find(([header]) => header.toLowerCase() === name)?.[1] ?? null
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
