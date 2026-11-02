import { DOCS_SCRIPT_MARK_ATTRIBUTE } from "@doxahq/contracts/docs-script-mark";
import { resolveSiteConfig, toClientSiteConfig } from "@doxahq/site-config";
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

import { Providers } from "@/src/providers";
import { createRouter } from "@/src/router";
import { SiteConfigProvider } from "@/src/site-config/site-config-context";
import { createScriptMark, scriptMarkAttributes } from "./script-mark";

// These two providers need a router, and this test has no router.
vi.mock("@/src/lib/transition", () => ({
  ViewTransitions: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/src/components/docs-icon", async (original) => ({
  ...(await original<typeof import("@/src/components/docs-icon")>()),
  RouteIconsProvider: ({ children }: { children: ReactNode }) => children,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

/** SECURITY REGRESSION GUARDRAIL (SEC-023): page content must not know the mark. */
describe("script mark", () => {
  test("is new for each server render", () => {
    expect(createScriptMark()).toMatch(/^[0-9a-f-]{36}$/);
    expect(createScriptMark()).not.toBe(createScriptMark());
  });

  test("gives the router a new mark for each server router", () => {
    const first = createRouter().options.ssr?.nonce;
    const second = createRouter().options.ssr?.nonce;

    expect(first).toBeTruthy();
    expect(first).not.toBe(second);
  });

  test("is not made in the browser", () => {
    vi.stubGlobal("document", {});

    expect(createScriptMark()).toBeUndefined();
  });

  test("marks the inline theme script, which the policy blocks without the mark", () => {
    const html = renderToString(
      createElement(SiteConfigProvider, {
        config: toClientSiteConfig(resolveSiteConfig({})),
        children: createElement(Providers, { scriptMark: "m4rk", children: "content" }),
      }),
    );
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];

    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script).toContain('nonce="m4rk"');
  });

  test("names the mark on the html tag only when there is a mark", () => {
    expect(scriptMarkAttributes("abc")).toEqual({ [DOCS_SCRIPT_MARK_ATTRIBUTE]: "abc" });
    expect(scriptMarkAttributes(undefined)).toEqual({});
  });
});
