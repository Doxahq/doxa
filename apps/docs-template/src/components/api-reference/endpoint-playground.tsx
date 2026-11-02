"use client";

import {
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type FormEvent,
} from "react";
import { RuntimeMdxContent } from "@/src/runtime/runtime-mdx-content";
import {
  createRuntimeMdxCodeBlock,
  type RuntimeMdxDocument,
} from "@doxahq/mdx-runtime";

import {
  buildBrowserRequest,
  isAuthParameter,
  loadSessionAuthToken,
  requestTargetOrigin,
  requestInputParameters,
  saveSessionAuthToken,
} from "@/src/lib/api-request";
import type { ApiParameterDefinition } from "@/src/lib/endpoint-document";
import {
  loadPlaygroundHighlighter,
  type PlaygroundHighlighter,
} from "@/src/lib/playground-highlighter";
import { cn } from "@/src/lib/utils";
import Copy from "@/src/components/markdown/copy";

interface PlaygroundResult {
  status: number;
  statusText: string;
  body: string;
  contentType: string | null;
  failed: boolean;
}

const LOCATION_LABELS: Record<string, string> = {
  path: "Path",
  query: "Query",
  header: "Header",
  body: "Body",
};

/**
 * Sends the documented request from the reader's browser.
 *
 * The credential lives in `sessionStorage`, keyed by the docs host. A
 * cross-origin API that does not send CORS headers fails here, so the error
 * text names that cause instead of showing a bare message.
 */
export function EndpointPlayground({
  method,
  path,
  baseUrl,
  parameters,
}: {
  method: string;
  path: string;
  baseUrl: string;
  parameters: readonly ApiParameterDefinition[];
}) {
  const [hydrated, setHydrated] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<PlaygroundResult | null>(null);
  const [highlighter, setHighlighter] = useState<PlaygroundHighlighter | null>(
    null
  );

  const inputs = useMemo(
    () => requestInputParameters(parameters),
    [parameters]
  );
  const authParameter = useMemo(
    () => parameters.find(isAuthParameter),
    [parameters]
  );
  const requiresAuth = Boolean(authParameter);
  const authPrefix =
    authParameter?.location === "header" &&
    ["bearer", "oauth2"].includes(authParameter.type.toLowerCase())
      ? "Bearer"
      : null;

  // Shows the reader the URL their values produce, including substituted path
  // segments. A parameter this component cannot send from a browser throws, and
  // the documented target is the honest thing to show in that case.
  const previewUrl = useMemo(() => {
    try {
      return showPathPlaceholders(
        buildBrowserRequest({
          method,
          path,
          baseUrl,
          parameters,
          values,
          token: "",
        }).url
      );
    } catch {
      return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
    }
  }, [method, path, baseUrl, parameters, values]);

  // The host that receives the credential, shown before the reader sends it
  // (SEC-010). It needs `window`, so it appears after hydration.
  const targetHost = hydrated ? new URL(requestTargetOrigin(baseUrl)).host : null;

  useEffect(() => {
    setHydrated(true);
    const stored = loadSessionAuthToken(baseUrl);
    if (stored) setToken(stored);
  }, [baseUrl]);

  useEffect(() => {
    let cancelled = false;

    void loadPlaygroundHighlighter()
      .then((loadedHighlighter) => {
        if (!cancelled) setHighlighter(loadedHighlighter);
      })
      .catch((error: unknown) => {
        console.warn(
          "[docs-template] Playground highlighter unavailable:",
          error
        );
      });

    return () => {
      cancelled = true;
    };
  }, []);

  function updateToken(value: string) {
    setToken(value);
    if (!hydrated) return;
    saveSessionAuthToken(baseUrl, value);
  }

  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hydrated || submitting) return;
    setSubmitting(true);
    setResult(null);

    try {
      const request = buildBrowserRequest({
        method,
        path,
        baseUrl,
        parameters,
        values,
        token,
      });
      const response = await fetch(request.url, request.init);
      const body = await response.text();
      setResult({
        status: response.status,
        statusText: response.statusText,
        body,
        contentType: response.headers.get("content-type"),
        failed: !response.ok,
      });
    } catch (error) {
      setResult({
        status: 0,
        statusText: "Request failed",
        body:
          "The browser could not complete this request. The API may not allow cross-origin requests from this docs site.\n\n" +
          (error instanceof Error ? error.message : String(error)),
        contentType: "text/plain",
        failed: true,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submitRequest} className="not-prose grid gap-4 p-4">
      <div className="grid gap-1.5">
        <FieldGroupLabel>Request</FieldGroupLabel>
        <Copy
          content={previewUrl}
          label="Copy request URL"
          className="font-code h-auto w-full justify-start overflow-hidden bg-muted/30 px-2.5 py-2 text-[0.7rem] font-normal text-muted-foreground shadow-none hover:bg-muted/50"
        >
          <span className="font-semibold text-foreground">
            {method.toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 scrollbar-none overflow-x-auto text-left whitespace-nowrap">
            {previewUrl}
          </span>
        </Copy>
      </div>

      {requiresAuth && (
        <label className="grid gap-1.5">
          <FieldGroupLabel>Authorization</FieldGroupLabel>
          <div className="flex h-8 items-center rounded-md border bg-background transition-colors focus-within:border-primary">
            {authPrefix && (
              <span
                data-auth-prefix={authPrefix}
                className="font-code shrink-0 px-2 text-xs text-muted-foreground select-none"
              >
                {authPrefix}
              </span>
            )}
            <input
              type="text"
              name="api-credential"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-lpignore="true"
              data-1p-ignore="true"
              data-bwignore="true"
              data-form-type="other"
              value={token}
              onChange={(event) => updateToken(event.target.value)}
              placeholder={authPrefix ? "Token" : "API key or token"}
              className="font-code h-full min-w-0 flex-1 bg-transparent px-2 text-xs outline-none"
            />
          </div>
          <span className="text-[0.65rem] text-muted-foreground">
            {targetHost ? (
              <>
                Sent only to{" "}
                <span className="font-code text-foreground">{targetHost}</span>
                .{" "}
              </>
            ) : null}
            Stored for this browser session. It never reaches the docs server.
          </span>
        </label>
      )}

      {inputs.length > 0 && (
        <div className="grid gap-1.5">
          <FieldGroupLabel>Parameters</FieldGroupLabel>
          {/* Two columns from `sm` up. One field per row wastes the width the
              stacked layout gained, and short values read better side by side. */}
          <div className="grid gap-3 sm:grid-cols-2">
            {inputs.map((parameter) => (
              <label
                key={`${parameter.location}:${parameter.name}`}
                className="grid min-w-0 content-start gap-1.5"
              >
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  <span className="font-code truncate">{parameter.name}</span>
                  <span className="font-code shrink-0 rounded bg-muted px-1 py-0.5 text-[0.6rem] text-muted-foreground">
                    {LOCATION_LABELS[parameter.location] ?? parameter.location}
                  </span>
                  {parameter.required && (
                    <span className="shrink-0 text-[0.65rem] text-destructive">
                      required
                    </span>
                  )}
                </span>
                <input
                  name={parameter.name}
                  value={values[parameter.name] ?? ""}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [parameter.name]: event.target.value,
                    }))
                  }
                  placeholder={parameter.type}
                  required={parameter.required}
                  className="font-code h-8 min-w-0 rounded-md border bg-background px-2 text-xs transition-colors outline-none focus:border-primary"
                />
              </label>
            ))}
          </div>
        </div>
      )}

      {inputs.length === 0 && !requiresAuth && (
        <p className="text-xs text-muted-foreground">
          This endpoint takes no request input.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={!hydrated || submitting}
          className="inline-flex h-8 shrink-0 cursor-pointer items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "Sending…" : "Send request"}
        </button>
        {result && (
          <span
            className={cn(
              "font-code text-xs",
              result.failed
                ? "text-destructive"
                : "text-emerald-600 dark:text-emerald-400"
            )}
          >
            {result.status > 0
              ? `${result.status} ${result.statusText}`.trim()
              : result.statusText}
          </span>
        )}
      </div>

      {result && (
        <div className="grid gap-1.5">
          <FieldGroupLabel>Response</FieldGroupLabel>
          <EndpointPlaygroundResponse
            body={result.body}
            contentType={result.contentType}
            highlighter={highlighter}
          />
        </div>
      )}
    </form>
  );
}

/** Section label inside the playground, matched to the card header weight. */
function FieldGroupLabel({ children }: { children: string }) {
  return (
    <span className="text-[0.65rem] font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </span>
  );
}

/**
 * Restores `{name}` in the preview. `URL` percent-encodes the braces of a path
 * parameter the reader has not filled in yet, and `%7Bid%7D` reads as a defect
 * rather than as the placeholder it is. Only the preview is rewritten. The
 * request itself still sends the encoded form.
 */
function showPathPlaceholders(url: string): string {
  return url.replace(/%7B([^%/?#]*)%7D/gi, "{$1}");
}

export function EndpointPlaygroundResponse({
  body,
  contentType,
  highlighter,
}: {
  body: string;
  contentType: string | null;
  highlighter: PlaygroundHighlighter | null;
}) {
  const document = useMemo<RuntimeMdxDocument>(() => {
    const formatted = formatResponseBody(body, contentType);
    return {
      frontmatter: {},
      nodes: [
        createRuntimeMdxCodeBlock(formatted.body, {
          language: formatted.language,
          ...(highlighter ? { highlighter } : {}),
        }),
      ],
    };
  }, [body, contentType, highlighter]);

  return (
    <RuntimeMdxContent
      document={document}
      components={{ pre: PlaygroundResponsePre }}
    />
  );
}

function PlaygroundResponsePre({
  children,
  raw,
  className,
  ...props
}: ComponentProps<"pre"> & { raw?: string }) {
  void raw;
  return (
    <pre
      {...props}
      className={cn(
        "font-code max-h-72 overflow-auto rounded-md border bg-muted/30 p-2.5 text-[0.7rem] whitespace-pre-wrap",
        className
      )}
    >
      {children}
    </pre>
  );
}

function formatResponseBody(
  body: string,
  contentType: string | null
): { body: string; language: "json" | "text" } {
  try {
    return {
      body: JSON.stringify(JSON.parse(body), null, 2),
      language: "json",
    };
  } catch {
    return {
      body,
      language: isJsonContentType(contentType) ? "json" : "text",
    };
  }
}

function isJsonContentType(contentType: string | null): boolean {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}
