import { DOCS_SCRIPT_MARK_ATTRIBUTE } from "@doxahq/contracts/docs-script-mark";

/**
 * The script and frame policy of docs HTML (SEC-023).
 *
 * Saved and cached HTML is shared by every visitor, so a nonce cannot live
 * in it. The renderer marks its own scripts with a random mark for each render
 * (`DOCS_SCRIPT_MARK_ATTRIBUTE`). The gateway gives a fresh nonce only to the
 * marked scripts, so a script that got into the page content does not run. The
 * policy allows only scripts with that nonce (`'strict-dynamic'` lets them load
 * the renderer's own chunks). Frames are limited to the video hosts of `<Embed>`.
 *
 * The mode comes from `DOXA_PROD_DOCS_CSP_MODE`:
 * - `report`: the policy is sent as Content-Security-Policy-Report-Only, and
 *   browsers report violations to {@link DOCS_CSP_REPORT_PATH};
 * - `enforce`: the policy is enforced;
 * - `off` (also any unknown value): nothing changes.
 */
export type DocsCspMode = "off" | "report" | "enforce";

export interface DocsCspEnv {
  DOXA_PROD_DOCS_CSP_MODE?: string;
}

/** Gives the nonce to the renderer's scripts of an HTML response. */
export type ScriptNonceWriter = (response: Response, nonce: string) => Response;

/** Where browsers send violation reports, on the docs host itself. */
export const DOCS_CSP_REPORT_PATH = "/__doxa/csp-report";

/**
 * The iframe origins that `<Embed>` produces (`packages/mdx-runtime/src/embed.ts`).
 * A test keeps this list equal to the resolver's output.
 */
export const EMBED_FRAME_ORIGINS = [
  "https://www.youtube-nocookie.com",
  "https://player.vimeo.com",
  "https://www.loom.com",
] as const;

/** The directives that every docs response already enforces. */
const BASELINE_DIRECTIVES = ["base-uri 'self'", "object-src 'none'"];

export function parseDocsCspMode(value: string | undefined): DocsCspMode {
  return value === "report" || value === "enforce" ? value : "off";
}

export function docsContentSecurityPolicy(nonce: string): string {
  return [
    ...BASELINE_DIRECTIVES,
    // `https:` and `'unsafe-inline'` only matter to browsers without nonce
    // support; a browser that knows `'strict-dynamic'` ignores both.
    `script-src 'nonce-${nonce}' 'strict-dynamic' https: 'unsafe-inline'`,
    `frame-src ${EMBED_FRAME_ORIGINS.join(" ")}`,
    `report-uri ${DOCS_CSP_REPORT_PATH}`,
  ].join("; ");
}

/** 16 random bytes, base64. */
export function createCspNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

/** The part of an HTMLRewriter element that the nonce rules use. */
export interface NonceRuleElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): unknown;
  removeAttribute(name: string): unknown;
  remove(): unknown;
}

export interface ScriptNonceRules {
  /** For each `<html>` tag. */
  root(element: NonceRuleElement): void;
  /** For each `<script>` tag. */
  script(element: NonceRuleElement): void;
  /** For each other tag with a `nonce`: the framework also marks `<link>` and `<style>`. */
  otherWithNonce(element: NonceRuleElement): void;
  /** For each `<meta>` tag that the framework writes to give the browser the nonce. */
  nonceMeta(element: NonceRuleElement): void;
}

/**
 * The rules for one response. Only the first `<html>` tag names the mark,
 * because it comes before all page content. A later `<html>` tag can come from
 * page content, so it names nothing.
 *
 * HTML without a mark comes from before the marks: a saved page or a cached
 * page. Its scripts must still run, so each script gets the nonce. New HTML
 * always has the mark, and page content cannot remove it.
 */
export function createScriptNonceRules(nonce: string): ScriptNonceRules {
  let rootSeen = false;
  let mark: string | null = null;
  const writeNonce = (element: NonceRuleElement, trusted: boolean) => {
    if (trusted) element.setAttribute("nonce", nonce);
    else element.removeAttribute("nonce");
  };

  return {
    root(element) {
      if (!rootSeen) {
        rootSeen = true;
        mark = element.getAttribute(DOCS_SCRIPT_MARK_ATTRIBUTE);
      }
      element.removeAttribute(DOCS_SCRIPT_MARK_ATTRIBUTE);
    },
    script(element) {
      writeNonce(element, mark === null || element.getAttribute("nonce") === mark);
    },
    otherWithNonce(element) {
      writeNonce(element, mark !== null && element.getAttribute("nonce") === mark);
    },
    nonceMeta(element) {
      // The browser does not need it: `'strict-dynamic'` trusts the scripts
      // that the renderer's own scripts add.
      element.remove();
    },
  };
}

/** The production writer: the Workers HTMLRewriter, streaming. */
export const htmlRewriterNonceWriter: ScriptNonceWriter = (response, nonce) => {
  const rules = createScriptNonceRules(nonce);
  return new HTMLRewriter()
    .on("html", { element: (element) => rules.root(element) })
    .on("script", { element: (element) => rules.script(element) })
    .on(":not(script)[nonce]", { element: (element) => rules.otherWithNonce(element) })
    .on('meta[property="csp-nonce"]', { element: (element) => rules.nonceMeta(element) })
    .transform(response);
};

/**
 * The HTML response with script nonces and the policy for `mode`. Any other
 * response, and every response in `off` mode, is returned unchanged.
 */
export function withDocsContentSecurityPolicy(
  response: Response,
  mode: DocsCspMode,
  writeNonces: ScriptNonceWriter = htmlRewriterNonceWriter,
  nonce: string = createCspNonce(),
): Response {
  if (mode === "off" || !isHtml(response)) return response;

  const rewritten = writeNonces(response, nonce);
  const result = new Response(rewritten.body, rewritten);
  // The nonces change the body length.
  result.headers.delete("content-length");
  const policy = docsContentSecurityPolicy(nonce);
  if (mode === "enforce") {
    result.headers.set("content-security-policy", policy);
  } else {
    result.headers.set("content-security-policy-report-only", policy);
  }
  return result;
}

function isHtml(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.split(";")[0]?.trim().toLowerCase() === "text/html";
}
