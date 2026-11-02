import { describe, expect, test, vi } from "vitest";

import { resolveEmbedUrl } from "../../../packages/mdx-runtime/src/embed";
import {
  EMBED_FRAME_ORIGINS,
  createCspNonce,
  createScriptNonceRules,
  docsContentSecurityPolicy,
  parseDocsCspMode,
  withDocsContentSecurityPolicy,
  type NonceRuleElement,
  type ScriptNonceWriter,
} from "../src/content-security-policy";
import { handleCspReport, parseCspReports } from "../src/csp-report";

/**
 * A stand-in for HTMLRewriter, which only the Workers runtime has. Streams like
 * it, and uses the production rules. It reads simple start tags only.
 */
const fakeNonceWriter: ScriptNonceWriter = (response, nonce) => {
  const rules = createScriptNonceRules(nonce);
  const rewriteTag = (tag: string, name: string, source: string): string => {
    const attributes = new Map(
      [...source.matchAll(/([\w-]+)="([^"]*)"/g)].map((match): [string, string] => [match[1]!, match[2]!]),
    );
    let removed = false;
    const element: NonceRuleElement = {
      getAttribute: (key) => attributes.get(key) ?? null,
      setAttribute: (key, value) => attributes.set(key, value),
      removeAttribute: (key) => attributes.delete(key),
      remove: () => {
        removed = true;
      },
    };
    if (name === "html") rules.root(element);
    else if (name === "script") rules.script(element);
    else if (attributes.get("property") === "csp-nonce") rules.nonceMeta(element);
    else if (attributes.has("nonce")) rules.otherWithNonce(element);
    else return tag;
    if (removed) return "";
    const ordered = [...attributes].sort(([key]) => (key === "nonce" ? -1 : 0));
    return `<${[name, ...ordered.map(([key, value]) => `${key}="${value}"`)].join(" ")}>`;
  };
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const html = await response.text();
      const output = html.replace(/<([a-z]+)((?:\s[^>]*)?)>/g, rewriteTag);
      controller.enqueue(new TextEncoder().encode(output));
      controller.close();
    },
  });
  return new Response(body, response);
};

function rewriteHtml(html: string, nonce = "n0nce"): Promise<string> {
  const response = new Response(html, { headers: { "content-type": "text/html" } });
  return withDocsContentSecurityPolicy(response, "enforce", fakeNonceWriter, nonce).text();
}

function htmlResponse(): Response {
  return new Response("<html><script>boot()</script><script src=\"/a.js\"></script></html>", {
    headers: { "content-type": "text/html; charset=utf-8", "content-length": "70" },
  });
}

/** SECURITY REGRESSION GUARDRAIL (SEC-023): docs scripts run only with a per-response nonce. */
describe("docs content security policy", () => {
  test("reads only report and enforce as modes", () => {
    expect(parseDocsCspMode("report")).toBe("report");
    expect(parseDocsCspMode("enforce")).toBe("enforce");
    expect(parseDocsCspMode(undefined)).toBe("off");
    expect(parseDocsCspMode("ENFORCE")).toBe("off");
  });

  test("allows scripts by nonce only, frames from the embed hosts, and reports to the docs host", () => {
    expect(docsContentSecurityPolicy("abc")).toBe(
      "base-uri 'self'; object-src 'none'; " +
        "script-src 'nonce-abc' 'strict-dynamic' https: 'unsafe-inline'; " +
        "frame-src https://www.youtube-nocookie.com https://player.vimeo.com https://www.loom.com; " +
        "report-uri /__doxa/csp-report",
    );
  });

  test("report mode adds nonces and a report-only policy, and keeps the enforced baseline", async () => {
    const response = htmlResponse();
    response.headers.set("content-security-policy", "base-uri 'self'; object-src 'none'");

    const result = withDocsContentSecurityPolicy(response, "report", fakeNonceWriter, "n0nce");

    expect(result.headers.get("content-security-policy-report-only")).toContain("'nonce-n0nce'");
    expect(result.headers.get("content-security-policy")).toBe("base-uri 'self'; object-src 'none'");
    expect(result.headers.has("content-length")).toBe(false);
    expect(await result.text()).toBe(
      '<html><script nonce="n0nce">boot()</script><script nonce="n0nce" src="/a.js"></script></html>',
    );
  });

  test("enforce mode replaces the baseline with the full policy", () => {
    const result = withDocsContentSecurityPolicy(htmlResponse(), "enforce", fakeNonceWriter, "n0nce");

    expect(result.headers.get("content-security-policy")).toBe(docsContentSecurityPolicy("n0nce"));
    expect(result.headers.has("content-security-policy-report-only")).toBe(false);
  });

  test("leaves non-HTML responses and off mode untouched", () => {
    const writer = vi.fn(fakeNonceWriter);
    const json = Response.json({ ok: true });
    const html = htmlResponse();

    expect(withDocsContentSecurityPolicy(json, "enforce", writer)).toBe(json);
    expect(withDocsContentSecurityPolicy(html, "off", writer)).toBe(html);
    expect(writer).not.toHaveBeenCalled();
  });

  test("gives the nonce to the marked scripts and removes the mark", async () => {
    const output = await rewriteHtml(
      '<html data-doxa-script-mark="m4rk" lang="en"><head>' +
        '<meta property="csp-nonce" content="m4rk">' +
        '<link rel="modulepreload" nonce="m4rk" href="/a.js">' +
        '</head><body><script nonce="m4rk">boot()</script><script nonce="m4rk" src="/a.js"></script></body></html>',
    );

    expect(output).toBe(
      '<html lang="en"><head>' +
        '<link nonce="n0nce" rel="modulepreload" href="/a.js">' +
        '</head><body><script nonce="n0nce">boot()</script><script nonce="n0nce" src="/a.js"></script></body></html>',
    );
  });

  test.each([
    ["no nonce", "<script>stealData()</script>", "<script>stealData()</script>"],
    ["a guessed nonce", '<script nonce="guess">stealData()</script>', "<script>stealData()</script>"],
    ["a source and no nonce", '<script src="https://evil.example/x.js"></script>', '<script src="https://evil.example/x.js"></script>'],
  ])("gives no nonce to a script from page content with %s", async (_label, injected, expected) => {
    const output = await rewriteHtml(
      `<html data-doxa-script-mark="m4rk"><body>${injected}<script nonce="m4rk">boot()</script></body></html>`,
    );

    expect(output).toBe(`<html><body>${expected}<script nonce="n0nce">boot()</script></body></html>`);
  });

  test("does not let a later html tag replace the mark", async () => {
    const output = await rewriteHtml(
      '<html data-doxa-script-mark="m4rk"><body>' +
        '<html data-doxa-script-mark="evil"><script nonce="evil">stealData()</script>' +
        '<script nonce="m4rk">boot()</script></body></html>',
    );

    expect(output).toBe(
      "<html><body><html><script>stealData()</script>" + '<script nonce="n0nce">boot()</script></body></html>',
    );
  });

  test("removes a nonce from other tags of page content", async () => {
    const output = await rewriteHtml(
      '<html data-doxa-script-mark="m4rk"><body><link rel="preload" nonce="guess" href="/x"></body></html>',
    );

    expect(output).toBe('<html><body><link rel="preload" href="/x"></body></html>');
  });

  test("still runs the scripts of HTML from before the marks", async () => {
    const output = await rewriteHtml('<html lang="en"><body><script>boot()</script><script src="/a.js"></script></body></html>');

    expect(output).toBe(
      '<html lang="en"><body><script nonce="n0nce">boot()</script><script nonce="n0nce" src="/a.js"></script></body></html>',
    );
  });

  test("makes a new nonce for every response", () => {
    expect(createCspNonce()).not.toBe(createCspNonce());
  });

  test.each([
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://vimeo.com/76979871",
    "https://www.loom.com/share/0123456789abcdef0123456789abcdef",
  ])("allows the frame that <Embed url=%j> renders", (url) => {
    const embed = resolveEmbedUrl(url);
    expect(embed).not.toBeNull();
    expect(EMBED_FRAME_ORIGINS).toContain(new URL(embed!.src).origin);
  });
});

describe("CSP violation reports", () => {
  test("reads the legacy report-uri form and a Reporting API batch, without query strings", () => {
    expect(
      parseCspReports(
        JSON.stringify({
          "csp-report": {
            "document-uri": "https://acme.doxa.page/guide?token=secret",
            "effective-directive": "script-src-elem",
            "blocked-uri": "https://cdn.evil.example/x.js?q=1",
          },
        }),
      ),
    ).toEqual([{ documentPath: "/guide", directive: "script-src-elem", blocked: "https://cdn.evil.example" }]);

    expect(
      parseCspReports(
        JSON.stringify([
          {
            type: "csp-violation",
            body: { documentURL: "https://acme.doxa.page/", effectiveDirective: "script-src-elem", blockedURL: "inline" },
          },
        ]),
      ),
    ).toEqual([{ documentPath: "/", directive: "script-src-elem", blocked: "inline" }]);

    expect(parseCspReports("not json")).toEqual([]);
  });

  test("logs a report and answers 204; refuses other methods and large bodies", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const report = JSON.stringify({ "csp-report": { "document-uri": "https://acme.doxa.page/a", "violated-directive": "frame-src", "blocked-uri": "https://x.example/f" } });

    const accepted = await handleCspReport(new Request("https://acme.doxa.page/__doxa/csp-report", { method: "POST", body: report }));
    const wrongMethod = await handleCspReport(new Request("https://acme.doxa.page/__doxa/csp-report"));
    const tooLarge = await handleCspReport(
      new Request("https://acme.doxa.page/__doxa/csp-report", {
        method: "POST",
        body: "{}",
        headers: { "content-length": String(16 * 1024 + 1) },
      }),
    );

    expect(accepted.status).toBe(204);
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toEqual({
      event: "docs_csp_report",
      host: "acme.doxa.page",
      documentPath: "/a",
      directive: "frame-src",
      blocked: "https://x.example",
    });
    expect(wrongMethod.status).toBe(405);
    expect(tooLarge.status).toBe(413);
    info.mockRestore();
  });
});
