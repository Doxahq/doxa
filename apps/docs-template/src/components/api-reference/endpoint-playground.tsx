"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  DOCS_TRY_TARGET_CHANGED_TITLE,
  isDocsTryTargetOfPage,
  type DocsTryConfig,
} from "@doxahq/contracts/docs-try";
import {
  createRuntimeMdxCodeBlock,
  type RuntimeMdxDocument,
} from "@doxahq/mdx-runtime";
import { LuDownload, LuPlus, LuX } from "react-icons/lu";

import { RuntimeMdxContent } from "@/src/runtime/runtime-mdx-content";
import {
  loadStoredRequestClient,
  saveStoredRequestClient,
} from "@/src/components/api-reference/request-clients";
import { RequestClientSelect } from "@/src/components/api-reference/request-client-select";
import { ApiMethodBadge } from "@/src/components/markdown/api-method-badge";
import Copy from "@/src/components/markdown/copy";
import {
  authValuePrefix,
  bodyFieldsToJson,
  buildBrowserRequest,
  buildPlaygroundRequest,
  buildRequestUrl,
  buildTryRequest,
  isAuthParameter,
  jsonBodyToFieldValues,
  loadSessionAuthToken,
  requestInputParameters,
  saveSessionAuthToken,
  type BrowserRequestInput,
} from "@/src/lib/api-request";
import {
  buildLiveSample,
  isLiveSampleClient,
  LIVE_SAMPLE_CLIENTS,
  type LiveSampleClient,
} from "@/src/lib/api-request-samples";
import type { ApiParameterDefinition } from "@/src/lib/endpoint-document";
import {
  loadPlaygroundHighlighter,
  type PlaygroundHighlighter,
} from "@/src/lib/playground-highlighter";
import {
  loadTryConfig,
  sendFromBrowser,
  sendThroughDoxa,
  type PlaygroundAnswer,
  type PlaygroundOutcome,
} from "@/src/lib/try-client";
import { Kbd, KbdGroup } from "@/src/components/ui/kbd";
import { cn } from "@/src/lib/utils";

/** Tinted from the button's own text color, so the keys match it in every site theme. */
const SEND_KEY_CLASS = "bg-primary-foreground/15 text-primary-foreground";
/** 70% of the default key size, to fit inside the 32px button. */
const BUTTON_KEY_SIZE_CLASS = "h-3.5 min-w-3.5 px-[3px] text-[0.625rem]";

/** `fields` sends the typed fields as JSON. `form` sends them URL-encoded. */
type BodyMode = "fields" | "json" | "form" | "text";

interface PlaygroundSession {
  values: Record<string, string>;
  bodyMode: BodyMode;
  rawBody: string;
  outcome: PlaygroundOutcome | null;
}

/**
 * Values stay when the panel closes and when the reader moves between
 * endpoints. They live in memory only, and the key is not one of them.
 */
const sessions = new Map<string, PlaygroundSession>();

const DELETE_CONFIRM_MS = 4_000;
const BODY_MODE_LABELS: Record<BodyMode, string> = {
  fields: "Fields",
  json: "JSON",
  form: "Form data",
  text: "Text",
};
const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

const FIELD_CLASS =
  "font-code h-8 w-full min-w-0 rounded-md border bg-background px-2 text-xs transition-colors outline-none focus:border-primary disabled:opacity-60";

function initialValues(
  parameters: readonly ApiParameterDefinition[]
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const parameter of parameters) {
    if (parameter.required && parameter.example) {
      values[parameter.name] = parameter.example;
    }
  }
  return values;
}

export interface EndpointExampleResponse {
  status: string;
  text: string;
  contentType?: string;
}

/**
 * The request form and the response of one endpoint.
 *
 * The request goes through `doxa-try-proxy` or from the reader's browser. The
 * config call decides that. The key lives in `sessionStorage`, per docs host and
 * target origin. A page load, a deep link or a prefill never sends a request.
 */
export function EndpointPlayground({
  method,
  path,
  baseUrl,
  parameters,
  exampleResponse,
  onClose,
  onSampleClientChange,
}: {
  method: string;
  path: string;
  baseUrl: string;
  parameters: readonly ApiParameterDefinition[];
  /** Shown before the first send, labeled as an example. */
  exampleResponse?: EndpointExampleResponse;
  onClose?: () => void;
  /** The reference page shows the same client as the panel. */
  onSampleClientChange?: (client: string) => void;
}) {
  const sessionKey = `${method} ${path}`;
  const saved = sessions.get(sessionKey);
  const inputs = useMemo(
    () => requestInputParameters(parameters),
    [parameters]
  );
  const bodyParameters = useMemo(
    () => inputs.filter((parameter) => parameter.location === "body"),
    [inputs]
  );
  const authParameter = useMemo(
    () => parameters.find(isAuthParameter),
    [parameters]
  );
  const upperMethod = method.toUpperCase();
  const acceptsBody = upperMethod !== "GET" && upperMethod !== "HEAD";

  const [hydrated, setHydrated] = useState(false);
  const [config, setConfig] = useState<DocsTryConfig | null>(null);
  const [proxyRefusedTarget, setProxyRefusedTarget] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(
    () => saved?.values ?? initialValues(parameters)
  );
  const [bodyMode, setBodyMode] = useState<BodyMode>(
    () => saved?.bodyMode ?? (bodyParameters.length > 0 ? "fields" : "json")
  );
  const [rawBody, setRawBody] = useState(() => saved?.rawBody ?? "");
  const [bodyNotice, setBodyNotice] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<PlaygroundOutcome | null>(
    () => saved?.outcome ?? null
  );
  const [token, setToken] = useState("");
  const [keyShown, setKeyShown] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [phoneView, setPhoneView] = useState<"request" | "response">("request");
  const [sampleClient, setSampleClient] = useState<LiveSampleClient>("curl");
  const [highlighter, setHighlighter] = useState<PlaygroundHighlighter | null>(
    null
  );
  const abortRef = useRef<AbortController | null>(null);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    sessions.set(sessionKey, { values, bodyMode, rawBody, outcome });
  }, [sessionKey, values, bodyMode, rawBody, outcome]);

  useEffect(() => {
    setHydrated(true);
    // Also when nothing is stored, so a key never stays for another base URL.
    setToken(loadSessionAuthToken(baseUrl));
    const storedClient = loadStoredRequestClient();
    if (isLiveSampleClient(storedClient)) setSampleClient(storedClient);
  }, [baseUrl]);

  useEffect(() => {
    const controller = new AbortController();
    void loadTryConfig(controller.signal).then((loaded) => {
      if (!controller.signal.aborted) setConfig(loaded);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadPlaygroundHighlighter()
      .then((loaded) => {
        if (!cancelled) setHighlighter(loaded);
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

  // Closing the panel stops a request that is still running.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    },
    []
  );

  const requestInput = useMemo<Omit<BrowserRequestInput, "token">>(
    () => ({
      method,
      path,
      baseUrl,
      parameters,
      values,
      ...(bodyMode === "json" || bodyMode === "text" ? { rawBody } : {}),
      bodyKind:
        bodyMode === "form" ? "form" : bodyMode === "text" ? "text" : "json",
    }),
    [method, path, baseUrl, parameters, values, bodyMode, rawBody]
  );

  // The URL that the values produce. It never holds the key.
  const previewUrl = useMemo(() => {
    try {
      const request = buildPlaygroundRequest({ ...requestInput, token: "" });
      return showPathPlaceholders(buildRequestUrl(baseUrl, request).toString());
    } catch {
      return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
    }
  }, [requestInput, baseUrl, path]);

  const sample = useMemo(() => {
    try {
      return showPathPlaceholders(buildLiveSample(sampleClient, requestInput));
    } catch {
      return "";
    }
  }, [sampleClient, requestInput]);

  // The host that receives the key. It needs `window`, so it appears after hydration.
  const targetChanged =
    proxyRefusedTarget ||
    (config?.mode === "proxy" &&
      !isDocsTryTargetOfPage(config.targetBaseUrl, baseUrl));
  const canSend =
    hydrated && config !== null && config.mode !== "off" && !targetChanged;

  // The key belongs to the target of this page, not to the new one.
  useEffect(() => {
    if (!targetChanged) return;
    setToken("");
    saveSessionAuthToken(baseUrl, "");
  }, [targetChanged, baseUrl]);

  function updateToken(value: string) {
    setToken(value);
    if (hydrated) saveSessionAuthToken(baseUrl, value);
  }

  function updateValue(name: string, value: string) {
    setValues((current) => ({ ...current, [name]: value }));
    setDeleteArmed(false);
  }

  function changeBodyMode(next: BodyMode) {
    if (next === bodyMode) return;
    setBodyNotice(null);
    const fromFields = bodyMode === "fields" || bodyMode === "form";
    const toFields = next === "fields" || next === "form";
    if (fromFields && next === "json") {
      const fields = bodyParameters.flatMap((parameter) => {
        const value = values[parameter.name];
        return value ? [{ parameter, value }] : [];
      });
      setRawBody(
        fields.length > 0
          ? JSON.stringify(bodyFieldsToJson(fields), null, 2)
          : ""
      );
    }
    if (bodyMode === "json" && toFields) {
      const parsed = jsonBodyToFieldValues(rawBody, bodyParameters);
      if (!parsed.ok) {
        setBodyNotice(
          parsed.reason === "invalid_json"
            ? "Fix the JSON before you switch views."
            : "This JSON has fields that the form does not show. Remove them before you switch views."
        );
        return;
      }
      setValues((current) => {
        const kept = { ...current };
        for (const parameter of bodyParameters) delete kept[parameter.name];
        return { ...kept, ...parsed.values };
      });
    }
    setBodyMode(next);
  }

  function selectSampleClient(client: string) {
    if (!isLiveSampleClient(client)) return;
    setSampleClient(client);
    saveStoredRequestClient(client);
    onSampleClientChange?.(client);
  }

  async function send() {
    if (!canSend || submitting || !config) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setSubmitting(true);
    setOutcome(null);
    setPhoneView("response");
    const options = {
      signal: controller.signal,
      onProgress: (answer: PlaygroundAnswer) => setOutcome(answer),
    };
    try {
      const input = { ...requestInput, token };
      const result =
        config.mode === "proxy"
          ? await sendThroughDoxa(buildTryRequest(input, config.targetId), options)
          : await sendFromBrowser(buildBrowserRequest(input), options);
      if (result.kind === "refused" && result.code === "target_changed") {
        setProxyRefusedTarget(true);
      }
      setOutcome(result);
    } catch (error) {
      setOutcome({
        kind: "failed",
        code: null,
        title: error instanceof Error ? error.message : String(error),
        keyLeftDoxa: false,
      });
    } finally {
      setSubmitting(false);
      abortRef.current = null;
    }
  }

  // A window capture listener runs before the dialog's own, so Esc stops the
  // request and leaves the dialog open. Without a request, Esc closes the dialog.
  useEffect(() => {
    if (!submitting) return;
    const cancelOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      abortRef.current?.abort();
    };
    window.addEventListener("keydown", cancelOnEscape, { capture: true });
    return () => window.removeEventListener("keydown", cancelOnEscape, { capture: true });
  }, [submitting]);

  function requestSend() {
    if (submitting) {
      abortRef.current?.abort();
      return;
    }
    const form = formRef.current;
    if (form && !form.checkValidity()) {
      setPhoneView("request");
      requestAnimationFrame(() => form.reportValidity());
      return;
    }
    if (upperMethod === "DELETE" && !deleteArmed) {
      setDeleteArmed(true);
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = setTimeout(
        () => setDeleteArmed(false),
        DELETE_CONFIRM_MS
      );
      return;
    }
    setDeleteArmed(false);
    void send();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    requestSend();
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (event.key !== "Enter") return;
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      requestSend();
      return;
    }
    // Only a deliberate press sends, because a request can change real data.
    if (target.tagName === "INPUT") event.preventDefault();
  }

  const activeSendFace = submitting ? "cancel" : deleteArmed ? "delete" : "send";
  // Every face stays in the same grid cell, so the button keeps one width.
  const sendFaces = [
    { id: "send", label: "Send", keys: ["⌘", "↵"], keyClass: SEND_KEY_CLASS },
    { id: "cancel", label: "Cancel", keys: ["Esc"], keyClass: "" },
    ...(upperMethod === "DELETE"
      ? [{ id: "delete", label: "Press again to delete", keys: [], keyClass: "" }]
      : []),
  ];
  const sendButton = (className?: string) => (
    <button
      type="button"
      onClick={requestSend}
      disabled={!canSend}
      className={cn(
        "inline-flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-md border px-3 text-xs font-medium transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        submitting
          ? "bg-background text-foreground"
          : deleteArmed
            ? "border-transparent bg-destructive text-white"
            : "border-transparent bg-primary text-primary-foreground",
        className
      )}
    >
      <span className="inline-grid justify-items-center">
        {sendFaces.map((face) => (
          <span
            key={face.id}
            className={cn(
              "col-start-1 row-start-1 inline-flex items-center gap-2",
              face.id !== activeSendFace && "invisible"
            )}
          >
            {face.label}
            {face.keys.length > 0 && (
              <KbdGroup className="hidden lg:inline-flex">
                {face.keys.map((key) => (
                  <Kbd key={key} className={cn(BUTTON_KEY_SIZE_CLASS, face.keyClass)}>
                    {key}
                  </Kbd>
                ))}
              </KbdGroup>
            )}
          </span>
        ))}
      </span>
    </button>
  );

  return (
    <div className="not-prose flex h-full min-h-0 flex-col" onKeyDown={onKeyDown}>
      <header className="flex items-center gap-2 border-b p-2 pl-3">
        <ApiMethodBadge method={method} />
        <Copy
          content={previewUrl}
          label="Copy request URL"
          className="font-code h-8 min-w-0 flex-1 justify-start overflow-hidden bg-muted/30 px-2.5 text-[0.7rem] font-normal text-muted-foreground shadow-none hover:bg-muted/50"
        >
          <span className="min-w-0 flex-1 scrollbar-none overflow-x-auto text-left whitespace-nowrap">
            {previewUrl}
          </span>
        </Copy>
        {sendButton("max-md:hidden")}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <LuX className="size-4" aria-hidden="true" />
          </button>
        )}
      </header>

      <PlaygroundNotice config={config} targetChanged={targetChanged} />

      <div className="flex gap-1 border-b p-1.5 md:hidden" role="group" aria-label="View">
        {(["request", "response"] as const).map((view) => (
          <button
            key={view}
            type="button"
            aria-pressed={phoneView === view}
            onClick={() => setPhoneView(view)}
            className={cn(
              "h-8 flex-1 cursor-pointer rounded-md text-xs font-medium capitalize",
              phoneView === view
                ? "bg-muted text-foreground"
                : "text-muted-foreground"
            )}
          >
            {view}
          </button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 md:grid-cols-2 md:divide-x">
        <form
          ref={formRef}
          onSubmit={onSubmit}
          noValidate={false}
          autoComplete="off"
          className={cn(
            "grid content-start gap-5 overflow-y-auto p-4",
            phoneView !== "request" && "max-md:hidden"
          )}
        >
          {authParameter && (
            <AuthField
              parameter={authParameter}
              token={token}
              shown={keyShown}
              onChange={updateToken}
              onToggleShown={() => setKeyShown((shown) => !shown)}
            />
          )}

          {(
            [
              ["path", "Path"],
              ["query", "Query"],
              ["header", "Headers"],
              ["cookie", "Cookies"],
            ] as const
          ).map(([location, title]) => (
            <ParameterSection
              key={location}
              title={title}
              parameters={inputs.filter(
                (parameter) => parameter.location === location
              )}
              values={values}
              onChange={updateValue}
              {...(location === "cookie" && config?.mode === "browser"
                ? {
                    note: "A browser cannot set cookies. To send them, use the code sample.",
                  }
                : {})}
            />
          ))}

          {acceptsBody && (
            <BodySection
              parameters={bodyParameters}
              values={values}
              onChange={updateValue}
              mode={bodyMode}
              onModeChange={changeBodyMode}
              rawBody={rawBody}
              onRawBodyChange={setRawBody}
              notice={bodyNotice}
            />
          )}

          {inputs.length === 0 && !authParameter && !acceptsBody && (
            <p className="text-xs text-muted-foreground">
              This endpoint takes no request input.
            </p>
          )}

          {upperMethod !== "GET" &&
            upperMethod !== "HEAD" &&
            upperMethod !== "OPTIONS" && (
              <p className="text-xs text-muted-foreground">
                This request can change real data.
              </p>
            )}
        </form>

        <div
          className={cn(
            "grid min-w-0 content-start gap-4 overflow-y-auto p-4",
            phoneView !== "response" && "max-md:hidden"
          )}
        >
          <SamplePane
            client={sampleClient}
            onSelect={selectSampleClient}
            code={sample}
            highlighter={highlighter}
          />
          {/* Last, because its height changes with each response. */}
          <ResponsePane
            outcome={outcome}
            submitting={submitting}
            exampleResponse={exampleResponse}
            highlighter={highlighter}
          />
        </div>
      </div>

      <footer className="border-t p-2 md:hidden">{sendButton("w-full")}</footer>
    </div>
  );
}

/**
 * Shows only when the reader must act: the target changed or the playground is
 * off. A normal page and a preview show nothing.
 */
function PlaygroundNotice({
  config,
  targetChanged,
}: {
  config: DocsTryConfig | null;
  targetChanged: boolean;
}) {
  if (!config) return null;
  let text: string | null = null;
  if (targetChanged) {
    text = DOCS_TRY_TARGET_CHANGED_TITLE;
  } else if (config.mode === "off") {
    text = "The owner of this site turned off the playground.";
  }
  if (!text) return null;
  return (
    <p className="border-b bg-muted/30 px-3 py-1.5 text-[0.7rem] font-medium text-foreground">
      {text}
    </p>
  );
}

function AuthField({
  parameter,
  token,
  shown,
  onChange,
  onToggleShown,
}: {
  parameter: ApiParameterDefinition;
  token: string;
  shown: boolean;
  onChange: (value: string) => void;
  onToggleShown: () => void;
}) {
  const prefix = authValuePrefix(parameter);
  const type = parameter.type.toLowerCase();
  const placeholder =
    type === "basic"
      ? "user:password"
      : prefix === "Bearer"
        ? "Token"
        : "API key or token";
  return (
    <section className="grid gap-1.5">
      <FieldGroupLabel>Authorization</FieldGroupLabel>
      <div className="flex h-8 items-center rounded-md border bg-background transition-colors focus-within:border-primary">
        {prefix && (
          <span
            data-auth-prefix={prefix}
            className="font-code shrink-0 px-2 text-xs text-muted-foreground select-none"
          >
            {prefix}
          </span>
        )}
        <input
          type={shown ? "text" : "password"}
          name="api-credential"
          aria-label="API key or token"
          autoComplete="new-password"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-lpignore="true"
          data-1p-ignore="true"
          data-bwignore="true"
          data-form-type="other"
          value={token}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="font-code h-full min-w-0 flex-1 bg-transparent px-2 text-xs outline-none"
        />
        <button
          type="button"
          onClick={onToggleShown}
          aria-pressed={shown}
          className="h-full shrink-0 cursor-pointer px-2 text-[0.65rem] text-muted-foreground hover:text-foreground"
        >
          {shown ? "Hide" : "Show"}
        </button>
        <button
          type="button"
          onClick={() => onChange("")}
          disabled={!token}
          className="h-full shrink-0 cursor-pointer px-2 text-[0.65rem] text-muted-foreground hover:text-foreground disabled:cursor-default disabled:opacity-50"
        >
          Clear
        </button>
      </div>
      <span className="text-[0.65rem] text-muted-foreground">
        Use a test key. Kept in this tab only.
      </span>
    </section>
  );
}

/** Stacked, not tabbed: a tab can hide a required field. */
function ParameterSection({
  title,
  parameters,
  values,
  onChange,
  note,
}: {
  title: string;
  parameters: readonly ApiParameterDefinition[];
  values: Readonly<Record<string, string>>;
  onChange: (name: string, value: string) => void;
  note?: string;
}) {
  if (parameters.length === 0) return null;
  return (
    <section className="grid gap-2">
      <FieldGroupLabel>{title}</FieldGroupLabel>
      {note && <p className="text-[0.65rem] text-muted-foreground">{note}</p>}
      <ParameterFields parameters={parameters} values={values} onChange={onChange} />
    </section>
  );
}

function ParameterFields({
  parameters,
  values,
  onChange,
}: {
  parameters: readonly ApiParameterDefinition[];
  values: Readonly<Record<string, string>>;
  onChange: (name: string, value: string) => void;
}) {
  const required = parameters.filter((parameter) => parameter.required);
  const optional = parameters.filter((parameter) => !parameter.required);
  const anyOptionalFilled = optional.some((parameter) => values[parameter.name]);
  const [optionalOpen, setOptionalOpen] = useState(
    anyOptionalFilled || required.length === 0 && optional.length <= 2
  );
  const visible = optionalOpen ? parameters : required;

  return (
    <>
      {visible.map((parameter) => (
        <ParameterField
          key={`${parameter.location}:${parameter.name}`}
          parameter={parameter}
          value={values[parameter.name] ?? ""}
          onChange={(value) => onChange(parameter.name, value)}
        />
      ))}
      {!optionalOpen && optional.length > 0 && (
        <button
          type="button"
          aria-expanded={false}
          onClick={() => setOptionalOpen(true)}
          className="flex min-w-0 cursor-pointer items-center gap-1.5 justify-self-start rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <LuPlus className="size-3 shrink-0" aria-hidden="true" />
          <span className="shrink-0">{optional.length} optional</span>
          <span className="font-code min-w-0 truncate text-[0.65rem] opacity-80">
            {optional.map((parameter) => parameter.name).join(", ")}
          </span>
        </button>
      )}
    </>
  );
}

const NUMBER_INPUT_TYPE = /^(?:integer|int|int32|int64|number|float|double|decimal|long)$/;
const WHOLE_NUMBER_TYPE = /^(?:integer|int|int32|int64|long)$/;
const JSON_INPUT_TYPE = /(?:\[\]|^array.*|^object.*|^map.*|^json.*)$/;

function ParameterField({
  parameter,
  value,
  onChange,
}: {
  parameter: ApiParameterDefinition;
  value: string;
  onChange: (value: string) => void;
}) {
  const type = parameter.type.trim().toLowerCase();
  const hint = parameter.example ?? parameter.defaultValue ?? parameter.type;
  const choices =
    parameter.enumValues ??
    (type === "boolean" || type === "bool" ? ["true", "false"] : null);
  const common = {
    name: parameter.name,
    value,
    required: parameter.required,
    spellCheck: false,
    onChange: (event: { target: { value: string } }) =>
      onChange(event.target.value),
  };

  let control: ReactNode;
  if (choices) {
    control = (
      <select {...common} className={FIELD_CLASS}>
        <option value="">
          {parameter.required
            ? "Select"
            : parameter.defaultValue
              ? `Default (${parameter.defaultValue})`
              : "Default"}
        </option>
        {choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    );
  } else if (JSON_INPUT_TYPE.test(type)) {
    control = (
      <textarea
        {...common}
        rows={3}
        placeholder={parameter.example ?? "JSON"}
        className="font-code min-w-0 rounded-md border bg-background px-2 py-1.5 text-xs transition-colors outline-none focus:border-primary"
      />
    );
  } else {
    control = (
      <input
        {...common}
        type={NUMBER_INPUT_TYPE.test(type) ? "number" : "text"}
        {...(NUMBER_INPUT_TYPE.test(type)
          ? { step: WHOLE_NUMBER_TYPE.test(type) ? 1 : "any" }
          : {})}
        placeholder={hint}
        className={FIELD_CLASS}
      />
    );
  }

  return (
    <label className="grid min-w-0 content-start gap-1">
      <span className="flex items-center gap-1.5 text-xs font-medium">
        <span className="font-code truncate">{parameter.name}</span>
        <span className="font-code shrink-0 rounded bg-muted px-1 py-0.5 text-[0.6rem] text-muted-foreground">
          {parameter.type}
        </span>
        {parameter.required && (
          <span className="shrink-0 text-[0.65rem] text-destructive">
            required
          </span>
        )}
      </span>
      {control}
    </label>
  );
}

function BodySection({
  parameters,
  values,
  onChange,
  mode,
  onModeChange,
  rawBody,
  onRawBodyChange,
  notice,
}: {
  parameters: readonly ApiParameterDefinition[];
  values: Readonly<Record<string, string>>;
  onChange: (name: string, value: string) => void;
  mode: BodyMode;
  onModeChange: (mode: BodyMode) => void;
  rawBody: string;
  onRawBodyChange: (value: string) => void;
  notice: string | null;
}) {
  const modes: readonly BodyMode[] =
    parameters.length > 0
      ? ["fields", "json", "form", "text"]
      : ["json", "text"];
  const jsonState =
    mode === "json" && rawBody.trim() ? checkJson(rawBody) : null;

  return (
    <section className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldGroupLabel>Body</FieldGroupLabel>
        <div className="flex rounded-md border p-0.5" role="group" aria-label="Body view">
          {modes.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={mode === option}
              onClick={() => onModeChange(option)}
              className={cn(
                "cursor-pointer rounded px-2 py-0.5 text-[0.65rem]",
                mode === option
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {BODY_MODE_LABELS[option]}
            </button>
          ))}
        </div>
      </div>

      {mode === "fields" || mode === "form" ? (
        <ParameterFields parameters={parameters} values={values} onChange={onChange} />
      ) : (
        <>
          <textarea
            aria-label={mode === "json" ? "JSON body" : "Text body"}
            value={rawBody}
            onChange={(event) => onRawBodyChange(event.target.value)}
            rows={8}
            spellCheck={false}
            placeholder={mode === "json" ? "{ }" : ""}
            className="font-code min-w-0 rounded-md border bg-background px-2 py-1.5 text-xs transition-colors outline-none focus:border-primary"
          />
          {jsonState && (
            <p className="text-[0.65rem] text-muted-foreground">
              {jsonState === "valid"
                ? "Valid JSON."
                : "This is not valid JSON. Doxa still sends it as you typed it."}
            </p>
          )}
        </>
      )}
      {notice && <p className="text-[0.65rem] text-destructive">{notice}</p>}
    </section>
  );
}

function checkJson(text: string): "valid" | "invalid" {
  try {
    JSON.parse(text);
    return "valid";
  } catch {
    return "invalid";
  }
}

function ResponsePane({
  outcome,
  submitting,
  exampleResponse,
  highlighter,
}: {
  outcome: PlaygroundOutcome | null;
  submitting: boolean;
  exampleResponse: EndpointExampleResponse | undefined;
  highlighter: PlaygroundHighlighter | null;
}) {
  return (
    <section className="grid min-w-0 gap-2">
      <FieldGroupLabel>Response</FieldGroupLabel>
      <div aria-live="polite" className="grid min-w-0 gap-2">
        {outcome?.kind === "answer" ? (
          <AnswerView answer={outcome} highlighter={highlighter} />
        ) : outcome ? (
          <ProblemView outcome={outcome} />
        ) : submitting ? (
          <p className="text-xs text-muted-foreground">Sending the request.</p>
        ) : exampleResponse ? (
          <>
            <p className="text-xs text-muted-foreground">
              Example of a {exampleResponse.status} response. Press Send to get
              a real one.
            </p>
            <EndpointPlaygroundResponse
              body={exampleResponse.text}
              contentType={exampleResponse.contentType ?? null}
              highlighter={highlighter}
            />
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Press Send to see the response here.
          </p>
        )}
      </div>
    </section>
  );
}

/** Doxa refused, or the connection failed. Each says if the key left Doxa. */
function ProblemView({
  outcome,
}: {
  outcome: Exclude<PlaygroundOutcome, PlaygroundAnswer>;
}) {
  const keyNote =
    outcome.kind === "refused" || outcome.keyLeftDoxa === false
      ? "Your key did not leave Doxa."
      : outcome.keyLeftDoxa
        ? "The API can have received your key."
        : null;
  return (
    <div
      className={cn(
        "grid gap-1 rounded-md p-3 text-xs",
        outcome.kind === "refused"
          ? "bg-muted text-foreground"
          : "bg-destructive/10 text-foreground"
      )}
    >
      <p className="font-medium">{outcome.title}</p>
      {outcome.kind === "failed" && outcome.detail && (
        <p className="text-muted-foreground">{outcome.detail}</p>
      )}
      {outcome.kind === "refused" && outcome.retryAfter && (
        <p className="text-muted-foreground">
          Try again in {formatWait(outcome.retryAfter)}.
        </p>
      )}
      {keyNote && <p className="text-muted-foreground">{keyNote}</p>}
    </div>
  );
}

function AnswerView({
  answer,
  highlighter,
}: {
  answer: PlaygroundAnswer;
  highlighter: PlaygroundHighlighter | null;
}) {
  const [tab, setTab] = useState<"body" | "headers">("body");
  const failed = answer.status >= 400;
  const statusText = answer.statusText || STATUS_TEXT[answer.status] || "";
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span
          className={cn(
            "font-code text-xs font-semibold",
            failed ? "text-destructive" : "text-primary"
          )}
        >
          {answer.status > 0 ? `${answer.status} ${statusText}`.trim() : statusText}
        </span>
        <span className="font-code text-[0.7rem] text-muted-foreground">
          {formatDuration(answer.elapsedMs)}
        </span>
        <span className="font-code text-[0.7rem] text-muted-foreground">
          {formatBytes(answer.bytes)}
          {answer.streaming ? "…" : ""}
        </span>
        <div className="ml-auto flex rounded-md border p-0.5" role="group" aria-label="Response view">
          {(["body", "headers"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={tab === option}
              onClick={() => setTab(option)}
              className={cn(
                "cursor-pointer rounded px-2 py-0.5 text-[0.65rem] capitalize",
                tab === option
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {option === "headers"
                ? `Headers (${answer.headers.length})`
                : option}
            </button>
          ))}
        </div>
      </div>

      <AnswerNotes answer={answer} />

      {tab === "headers" ? (
        <HeaderList answer={answer} />
      ) : answer.text === null ? (
        answer.raw && (
          <p className="text-xs text-muted-foreground">
            This response is binary, so the panel does not show it.
          </p>
        )
      ) : answer.text ? (
        <EndpointPlaygroundResponse
          body={answer.text}
          contentType={answer.contentType}
          highlighter={highlighter}
        />
      ) : (
        <p className="text-xs text-muted-foreground">The response has no body.</p>
      )}

      {answer.raw && (answer.text === null || answer.textCut) && !answer.streaming && (
        <button
          type="button"
          onClick={() => saveBody(answer.raw!)}
          className="inline-flex cursor-pointer items-center gap-1.5 justify-self-start rounded-md border px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted"
        >
          <LuDownload className="size-3" aria-hidden="true" />
          Save the response
        </button>
      )}
    </>
  );
}

function AnswerNotes({ answer }: { answer: PlaygroundAnswer }) {
  const notes: string[] = [];
  if (answer.status === 401 || answer.status === 403) {
    notes.push("The API refused this request. Check your key.");
  }
  if (answer.redirect) {
    notes.push(
      answer.redirect.location
        ? `The API redirected to ${answer.redirect.location}. The playground does not follow redirects, so your key stays with this host.`
        : "The API sent a redirect. A browser does not show where it goes, and the playground does not follow it."
    );
  }
  if (answer.textCut) {
    notes.push("The panel shows only the first part of this response.");
  }
  if (answer.stoppedBy === "size") notes.push("The response stopped at the 10 MB limit.");
  if (answer.stoppedBy === "time") notes.push("The response stopped at the time limit.");
  if (answer.stoppedBy === "reader") notes.push("You canceled this response.");
  if (notes.length === 0) return null;
  return (
    <div className="grid gap-1 rounded-md bg-muted p-2.5 text-xs break-words text-muted-foreground">
      {notes.map((note) => (
        <p key={note}>{note}</p>
      ))}
    </div>
  );
}

function HeaderList({ answer }: { answer: PlaygroundAnswer }) {
  return (
    <div className="grid gap-1.5">
      {answer.via === "browser" && (
        <p className="text-[0.65rem] text-muted-foreground">
          A browser shows only the headers that the API exposes.
        </p>
      )}
      <dl className="font-code grid gap-1 rounded-md border bg-muted/30 p-2.5 text-[0.7rem]">
        {answer.headers.map(([name, value], index) => (
          <div key={`${name}:${index}`} className="min-w-0 break-words">
            <dt className="inline font-semibold">{name}: </dt>
            <dd className="inline text-muted-foreground">{value}</dd>
          </div>
        ))}
        {answer.headers.length === 0 && (
          <span className="text-muted-foreground">No headers.</span>
        )}
      </dl>
      {answer.headersTruncated && (
        <p className="text-[0.65rem] text-muted-foreground">
          The API sent more headers than the panel can show.
        </p>
      )}
    </div>
  );
}

function SamplePane({
  client,
  onSelect,
  code,
  highlighter,
}: {
  client: LiveSampleClient;
  onSelect: (client: string) => void;
  code: string;
  highlighter: PlaygroundHighlighter | null;
}) {
  const language =
    LIVE_SAMPLE_CLIENTS.find((entry) => entry.client === client)?.language ??
    "bash";
  return (
    <section className="grid min-w-0 gap-2">
      <div className="flex items-center justify-between gap-2">
        <FieldGroupLabel>Code sample</FieldGroupLabel>
        <div className="flex items-center gap-1.5">
          <RequestClientSelect
            clients={LIVE_SAMPLE_CLIENTS.map((entry) => entry.client)}
            active={client}
            onSelect={onSelect}
          />
          {code && <Copy content={code} label="Copy code sample" className="size-7!" />}
        </div>
      </div>
      {code && (
        <PlaygroundCode code={code} language={language} highlighter={highlighter} />
      )}
    </section>
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

/** A response always draws as text, so a target's HTML or SVG never runs here. */
export function EndpointPlaygroundResponse({
  body,
  contentType,
  highlighter,
}: {
  body: string;
  contentType: string | null;
  highlighter: PlaygroundHighlighter | null;
}) {
  const formatted = useMemo(
    () => formatResponseBody(body, contentType),
    [body, contentType]
  );
  return (
    <PlaygroundCode
      code={formatted.body}
      language={formatted.language}
      highlighter={highlighter}
    />
  );
}

function PlaygroundCode({
  code,
  language,
  highlighter,
}: {
  code: string;
  language: string;
  highlighter: PlaygroundHighlighter | null;
}) {
  const document = useMemo<RuntimeMdxDocument>(
    () => ({
      frontmatter: {},
      nodes: [
        createRuntimeMdxCodeBlock(code, {
          language,
          ...(highlighter ? { highlighter } : {}),
        }),
      ],
    }),
    [code, language, highlighter]
  );

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
        "font-code max-h-[28rem] overflow-auto rounded-md border bg-muted/30 p-2.5 text-[0.7rem] whitespace-pre-wrap",
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

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWait(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  if (seconds < 90 * 60) return `${Math.ceil(seconds / 60)} minutes`;
  return `${Math.ceil(seconds / 3600)} hours`;
}

/** Saved as bytes with a neutral type, so the browser never renders it here. */
function saveBody(raw: Uint8Array): void {
  const url = URL.createObjectURL(
    new Blob([raw as BlobPart], { type: "application/octet-stream" })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "response.bin";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
