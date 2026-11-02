import { DOCS_CSP_REPORT_PATH } from "./content-security-policy";

/** A report is a few hundred bytes; more is not a browser report. */
const MAX_REPORT_BYTES = 16 * 1024;
/** One request can carry a batch; a few lines are enough to see a pattern. */
const MAX_LOGGED_REPORTS = 10;

/** One CSP violation, reduced to what helps decide the policy. */
export interface CspViolation {
  documentPath: string;
  directive: string;
  blocked: string;
}

export function isCspReportRequest(request: Request): boolean {
  return new URL(request.url).pathname === DOCS_CSP_REPORT_PATH;
}

/**
 * Logs the CSP violations that browsers send in report mode (SEC-023), one
 * JSON line each, so the policy can be checked before it is enforced. Only
 * the page path, the directive and the blocked origin are kept: no query
 * strings, no full URLs.
 */
export async function handleCspReport(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  const body = await readBoundedText(request, MAX_REPORT_BYTES);
  if (body === null) return new Response(null, { status: 413 });

  const host = new URL(request.url).hostname;
  for (const violation of parseCspReports(body).slice(0, MAX_LOGGED_REPORTS)) {
    console.info(JSON.stringify({ event: "docs_csp_report", host, ...violation }));
  }
  return new Response(null, { status: 204 });
}

/**
 * The violations of a report body: the legacy `{"csp-report": {...}}` form
 * of `report-uri`, or a Reporting API batch. Anything else yields none.
 */
export function parseCspReports(body: string): CspViolation[] {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return [];
  }
  const bodies = Array.isArray(value)
    ? value.map((entry) => (isRecord(entry) ? entry.body : undefined))
    : [isRecord(value) ? value["csp-report"] : undefined];
  return bodies.flatMap((body) => (isRecord(body) ? [toViolation(body)] : []));
}

function toViolation(body: Record<string, unknown>): CspViolation {
  return {
    documentPath: pathOf(stringField(body["document-uri"] ?? body.documentURL)),
    directive: stringField(body["effective-directive"] ?? body.effectiveDirective ?? body["violated-directive"]),
    blocked: originOrKeyword(stringField(body["blocked-uri"] ?? body.blockedURL)),
  };
}

/** `inline`, `eval` and similar keywords stay; a URL becomes its origin. */
function originOrKeyword(value: string): string {
  return URL.canParse(value) ? new URL(value).origin : value.slice(0, 64);
}

function pathOf(value: string): string {
  return URL.canParse(value) ? new URL(value).pathname : "";
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The body as text, or null above `maxBytes`. */
async function readBoundedText(request: Request, maxBytes: number): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > maxBytes) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let result = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return result + decoder.decode();
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    result += decoder.decode(chunk.value, { stream: true });
  }
}
