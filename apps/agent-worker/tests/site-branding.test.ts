import { describe, expect, test, vi } from "vitest";
import type { InternalApiRpc } from "@doxahq/contracts";
import { resolveSiteConfig } from "@doxahq/site-config";
import { applyDiscoveredBranding } from "../src/site-branding/apply";
import { discoverBranding, type DiscoveredBranding } from "../src/site-branding/discover";
import { fetchPublic, isFetchableUrl, type Fetcher } from "../src/site-branding/fetch";
import { resolveReadmeImage } from "../src/site-branding/github";
import { footerGroups } from "../src/site-branding/homepage";
import { inspectImage } from "../src/site-branding/image";
import { contextDevApiKey, runSiteBrandingStep } from "../src/site-branding";
import { socialLink } from "../src/site-branding/socials";

const encoder = new TextEncoder();

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set(encoder.encode("IHDR"), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 32"><path fill="#3ECF8E" d="M0 0h10v10z"/><path fill="#3ECF8E" d="M10 0h10v10z"/><text fill="#1C1C1C">acme</text></svg>`;
const WHITE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 32"><path fill="#FFFFFF" d="M0 0h10v10z"/></svg>`;
const NEUTRAL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 32"><path fill="#000" d="M0 0h10v10z"/></svg>`;

describe("image checks", () => {
  test("reads the dominant colored paint of an SVG logo", () => {
    const info = inspectImage(encoder.encode(LOGO_SVG), "logo");
    expect(info).toMatchObject({ format: "svg", dominantColor: "#3ECF8E", lightOnly: false });
  });

  test("marks an all-white SVG as a dark-background logo", () => {
    expect(inspectImage(encoder.encode(WHITE_SVG), "logo")).toMatchObject({ lightOnly: true });
  });

  test("rejects an SVG whose paint came from the page CSS", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 32" fill="none"><path class="logo-path" d="M0 0h10"/></svg>`;
    expect(inspectImage(encoder.encode(svg), "logo")).toEqual({ rejected: "unpainted_svg" });
  });

  test("rejects banners and hero images as logos", () => {
    expect(inspectImage(png(1800, 120), "logo")).toEqual({ rejected: "banner_shape" });
    expect(inspectImage(png(1600, 900), "logo")).toEqual({ rejected: "banner_shape" });
    expect(inspectImage(png(400, 100), "logo")).toMatchObject({ format: "png", width: 400, height: 100 });
  });

  test("rejects files that are not images", () => {
    expect(inspectImage(encoder.encode("<html></html>"), "logo")).toEqual({ rejected: "unknown_format" });
  });
});

describe("URL guard", () => {
  test("refuses IP literals, local names and odd ports", () => {
    expect(isFetchableUrl("https://acme.dev/")).toBe(true);
    expect(isFetchableUrl("http://169.254.169.254/latest")).toBe(false);
    expect(isFetchableUrl("http://[::1]/")).toBe(false);
    expect(isFetchableUrl("http://localhost/")).toBe(false);
    expect(isFetchableUrl("http://printer.local/")).toBe(false);
    expect(isFetchableUrl("https://acme.dev:8443/")).toBe(false);
    expect(isFetchableUrl("ftp://acme.dev/")).toBe(false);
    expect(isFetchableUrl("https://user:pw@acme.dev/")).toBe(false);
  });

  test("does not follow a redirect to a private address", async () => {
    const fetcher = vi.fn<Fetcher>(async () =>
      new Response(null, { status: 302, headers: { location: "http://10.0.0.1/" } }),
    );
    expect(await fetchPublic(fetcher, "https://acme.dev/", { maxBytes: 100, timeoutMs: 1000 })).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("stops reading past the size cap", async () => {
    const fetcher: Fetcher = async () => new Response("x".repeat(500));
    expect(await fetchPublic(fetcher, "https://acme.dev/", { maxBytes: 100, timeoutMs: 1000 })).toBeNull();
  });
});

describe("page signals", () => {
  test("normalizes social profile links and skips share links", () => {
    expect(socialLink("https://twitter.com/acme?ref=footer")).toEqual({ kind: "x", url: "https://twitter.com/acme" });
    expect(socialLink("https://github.com/acme/repo/issues")).toEqual({ kind: "github", url: "https://github.com/acme" });
    expect(socialLink("https://x.com/intent/tweet?text=hi")).toBeNull();
    expect(socialLink("https://www.youtube.com/watch?v=1")).toBeNull();
    expect(socialLink("https://discord.gg/abc")).toEqual({ kind: "discord", url: "https://discord.gg/abc" });
  });

  test("reads titled link lists from the footer, same site only", () => {
    const html = `<footer>
      <div><h3>Product</h3><ul><li><a href="/pricing">Pricing</a></li><li><a href="https://docs.acme.dev/">Docs</a></li><li><a href="https://other.com/x">Partner</a></li></ul></div>
      <div><p>Company</p><ul><li><a href="/about">About</a></li><li><a href="/blog">Blog</a></li><li><a href="https://x.com/acme">X</a></li></ul></div>
      <ul><li><a href="/only">Only one</a></li></ul>
    </footer>`;
    expect(footerGroups(html, "https://acme.dev/")).toEqual([
      { title: "Product", links: [{ label: "Pricing", href: "https://acme.dev/pricing" }, { label: "Docs", href: "https://docs.acme.dev/" }] },
      { title: "Company", links: [{ label: "About", href: "https://acme.dev/about" }, { label: "Blog", href: "https://acme.dev/blog" }] },
    ]);
  });

  test("resolves README images inside the repo through the API", () => {
    expect(resolveReadmeImage("./media/logo.svg", "README.md", "acme/tool")).toEqual({ kind: "repo", path: "media/logo.svg" });
    expect(resolveReadmeImage("https://raw.githubusercontent.com/Acme/tool/main/docs/logo.png", "README.md", "acme/tool")).toEqual({ kind: "repo", path: "docs/logo.png" });
    expect(resolveReadmeImage("https://cdn.acme.dev/logo.svg", "README.md", "acme/tool")).toEqual({ kind: "url", url: "https://cdn.acme.dev/logo.svg" });
  });
});

/** A fake web: GitHub API, the homepage, its assets, and Context.dev. */
function fakeWeb(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetcher = vi.fn<Fetcher>(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const route = routes[url];
    return route ? route() : new Response("not found", { status: 404 });
  });
  return { fetcher, calls };
}

const json = (value: unknown) => () => Response.json(value);
const text = (value: string, type: string) => () => new Response(value, { headers: { "content-type": type } });
const bytes = (value: Uint8Array, type: string) => () => new Response(value.buffer as ArrayBuffer, { headers: { "content-type": type } });
const b64 = (value: string) => btoa(value);

const HOMEPAGE = `<!doctype html><html><head>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <script type="application/ld+json">{"@type":"Organization","logo":"https://acme.dev/ld-logo.png","sameAs":["https://www.linkedin.com/company/acme"]}</script>
</head><body>
  <header><a href="/"><img src="/brand/logo.svg" alt="Acme logo"></a></header>
  <footer><h4>Product</h4><ul><li><a href="/pricing">Pricing</a></li><li><a href="/changelog">Changelog</a></li></ul>
  <a href="https://twitter.com/acme">X</a></footer>
</body></html>`;

function acmeRoutes(overrides: Record<string, () => Response> = {}) {
  return {
    "https://api.github.com/repos/acme/tool": json({
      full_name: "acme/tool",
      html_url: "https://github.com/acme/tool",
      private: false,
      default_branch: "main",
      homepage: "https://acme.dev",
      owner: { login: "acme", html_url: "https://github.com/acme", type: "Organization" },
    }),
    "https://api.github.com/orgs/acme": json({ blog: "https://acme.dev", twitter_username: "acmehq" }),
    "https://api.github.com/repos/acme/tool/readme": json({ path: "README.md", encoding: "base64", content: b64("# Tool\nNo logo here.\n") }),
    "https://api.github.com/repos/acme/tool/git/trees/main?recursive=1": json({ tree: [] }),
    "https://acme.dev/": text(HOMEPAGE, "text/html; charset=utf-8"),
    "https://acme.dev/brand/logo.svg": text(LOGO_SVG, "image/svg+xml"),
    "https://acme.dev/favicon.svg": text(NEUTRAL_SVG, "image/svg+xml"),
    ...overrides,
  };
}

function storeAsset() {
  let next = 0;
  return vi.fn(async (_kind: "logo" | "favicon", _bytes: Uint8Array) => `asset:${String(next++).padStart(64, "0")}`);
}

describe("branding discovery", () => {
  test("finds logo, color, favicon, socials and footer without Context.dev", async () => {
    const web = fakeWeb(acmeRoutes());
    const store = storeAsset();
    const found = await discoverBranding({
      repositoryFullName: "acme/tool",
      fetch: web.fetcher,
      githubToken: "token",
      contextDevApiKey: null,
      storeAsset: store,
    });
    expect(found).toMatchObject({
      homepage: "https://acme.dev/",
      repositoryUrl: "https://github.com/acme/tool",
      logo: { source: "homepage_header", dark: null },
      primaryColor: { hex: "#3ECF8E", source: "logo" },
      socials: {
        github: "https://github.com/acme",
        x: "https://x.com/acmehq",
        linkedin: "https://www.linkedin.com/company/acme",
      },
      footerGroups: [{ title: "Product", links: [{ label: "Pricing", href: "https://acme.dev/pricing" }, { label: "Changelog", href: "https://acme.dev/changelog" }] }],
      contextDev: "disabled",
    });
    expect(store.mock.calls.map(([kind]) => kind)).toEqual(["logo", "favicon"]);
    expect(web.calls.some((url) => url.includes("context.dev"))).toBe(false);
  });

  test("prefers a README picture with light and dark sources", async () => {
    const readme = `<p align="center"><picture>
      <source media="(prefers-color-scheme: dark)" srcset="./media/logo-dark.svg">
      <img src="./media/logo.svg" alt="Tool">
    </picture></p>`;
    const web = fakeWeb(acmeRoutes({
      "https://api.github.com/repos/acme/tool/readme": json({ path: "README.md", encoding: "base64", content: b64(readme) }),
      "https://api.github.com/repos/acme/tool/contents/media/logo.svg?ref=main": text(LOGO_SVG, "image/svg+xml"),
      "https://api.github.com/repos/acme/tool/contents/media/logo-dark.svg?ref=main": text(WHITE_SVG, "image/svg+xml"),
    }));
    const found = await discoverBranding({
      repositoryFullName: "acme/tool",
      fetch: web.fetcher,
      githubToken: "token",
      contextDevApiKey: null,
      storeAsset: storeAsset(),
    });
    expect(found?.logo).toMatchObject({ source: "readme_picture" });
    expect(found?.logo?.dark).not.toBeNull();
  });

  test("calls Context.dev only when it is on and no logo was found", async () => {
    const noLogo = acmeRoutes({ "https://acme.dev/brand/logo.svg": () => new Response("gone", { status: 404 }) });
    const contextResponse = json({
      brand: {
        logos: [
          { url: "https://media.context.dev/acme-light.png", mode: "light", type: "logo", colors: [{ hex: "#111111" }, { hex: "#635BFF" }] },
          { url: "https://media.context.dev/acme-dark.png", mode: "dark", type: "logo", colors: [] },
        ],
        socials: [{ type: "youtube", url: "https://youtube.com/@acme" }],
      },
    });
    const web = fakeWeb({
      ...noLogo,
      "https://api.context.dev/v1/brand/retrieve": contextResponse,
      "https://media.context.dev/acme-light.png": bytes(png(400, 100), "image/png"),
      "https://media.context.dev/acme-dark.png": bytes(png(400, 100), "image/png"),
    });
    const found = await discoverBranding({
      repositoryFullName: "acme/tool",
      fetch: web.fetcher,
      githubToken: "token",
      contextDevApiKey: "ctxt_secret_test",
      storeAsset: storeAsset(),
    });
    expect(found).toMatchObject({
      contextDev: "used",
      logo: { source: "context_dev" },
      primaryColor: { hex: "#635BFF", source: "context_dev_logo" },
      socials: { youtube: "https://youtube.com/@acme" },
    });
    expect(found?.logo?.dark).not.toBeNull();
    const contextCall = web.fetcher.mock.calls.find(([url]) => url === "https://api.context.dev/v1/brand/retrieve");
    expect(JSON.parse(String(contextCall?.[1]?.body))).toMatchObject({ type: "by_domain", domain: "acme.dev" });
  });

  test("does not call Context.dev for a black-and-white SVG logo", async () => {
    const web = fakeWeb(acmeRoutes({ "https://acme.dev/brand/logo.svg": text(NEUTRAL_SVG, "image/svg+xml") }));
    const found = await discoverBranding({
      repositoryFullName: "acme/tool",
      fetch: web.fetcher,
      githubToken: "token",
      contextDevApiKey: "ctxt_secret_test",
      storeAsset: storeAsset(),
    });
    expect(found).toMatchObject({ contextDev: "not_needed", primaryColor: null });
    expect(web.calls.some((url) => url.includes("context.dev"))).toBe(false);
  });

  test("never reads a package registry as the brand homepage", async () => {
    const web = fakeWeb(acmeRoutes({
      "https://api.github.com/repos/acme/tool": json({
        full_name: "acme/tool",
        html_url: "https://github.com/acme/tool",
        private: false,
        default_branch: "main",
        homepage: "https://www.npmjs.com/package/tool",
        owner: { login: "acme", html_url: "https://github.com/acme", type: "User" },
      }),
      "https://api.github.com/users/acme": json({ blog: "https://acme.dev" }),
    }));
    const found = await discoverBranding({
      repositoryFullName: "acme/tool",
      fetch: web.fetcher,
      githubToken: "token",
      contextDevApiKey: null,
      storeAsset: storeAsset(),
    });
    expect(found?.homepage).toBeNull();
    expect(web.calls.some((url) => url.startsWith("https://www.npmjs.com"))).toBe(false);
    expect(web.calls.some((url) => url.startsWith("https://acme.dev"))).toBe(false);
  });
});

function discovered(overrides: Partial<DiscoveredBranding> = {}): DiscoveredBranding {
  return {
    homepage: "https://acme.dev/",
    repositoryUrl: "https://github.com/acme/tool",
    repositoryIsPrivate: false,
    logo: { light: `asset:${"a".repeat(64)}`, dark: `asset:${"b".repeat(64)}`, source: "readme_picture" },
    favicon: `asset:${"c".repeat(64)}`,
    primaryColor: { hex: "#635BFF", source: "logo" },
    socials: { github: "https://github.com/acme", x: "https://x.com/acmehq" },
    footerGroups: [{ title: "Product", links: [{ label: "Pricing", href: "https://acme.dev/pricing" }, { label: "Blog", href: "https://acme.dev/blog" }] }],
    contextDev: "disabled",
    ...overrides,
  };
}

describe("applying branding", () => {
  test("fills every default field of a new site", () => {
    const { config, applied } = applyDiscoveredBranding(undefined, "Tool", discovered());
    const resolved = resolveSiteConfig(config);
    expect(applied).toEqual(["logo", "logo_dark", "favicon", "primary_color", "github", "socials", "footer"]);
    expect(resolved.branding.logo).toMatchObject({ light: `asset:${"a".repeat(64)}`, dark: `asset:${"b".repeat(64)}` });
    expect(resolved.theme.tokens.light).toMatchObject({ primary: "#635BFF", primaryForeground: "#FFFFFF" });
    expect(resolved.theme.tokens.dark).toMatchObject({ primary: "#635BFF" });
    expect(resolved.navbar.github).toBe("https://github.com/acme/tool");
    expect(resolved.footer.socials).toMatchObject({ github: "https://github.com/acme", x: "https://x.com/acmehq" });
    expect(resolved.footer.groups).toHaveLength(1);
  });

  test("keeps a light brand color out of the light theme, where it does not read", () => {
    const { config } = applyDiscoveredBranding(undefined, "Tool", discovered({ primaryColor: { hex: "#C5F74F", source: "logo" } }));
    const resolved = resolveSiteConfig(config);
    expect(resolved.theme.tokens.light.primary).not.toBe("#C5F74F");
    expect(resolved.theme.tokens.dark).toMatchObject({ primary: "#C5F74F", primaryForeground: "#000000" });
  });

  test("never changes a field that a person set", () => {
    const base = resolveSiteConfig({
      name: "Tool",
      branding: { logo: { light: `asset:${"d".repeat(64)}` } },
      theme: { primary: "#FF0000" },
      navbar: { github: "https://github.com/acme/other" },
      footer: { socials: { x: "https://x.com/someone" } },
    });
    const { config, applied } = applyDiscoveredBranding(base, "Tool", discovered());
    const resolved = resolveSiteConfig(config);
    expect(applied).not.toContain("logo");
    expect(applied).not.toContain("primary_color");
    expect(applied).not.toContain("github");
    expect(resolved.branding.logo.light).toBe(`asset:${"d".repeat(64)}`);
    expect(resolved.theme.primary).toBe("#FF0000");
    expect(resolved.navbar.github).toBe("https://github.com/acme/other");
    expect(resolved.footer.socials.x).toBe("https://x.com/someone");
    expect(resolved.footer.socials.github).toBe("https://github.com/acme");
  });

  test("does not link the navbar to a private repository", () => {
    const { config, applied } = applyDiscoveredBranding(undefined, "Tool", discovered({ repositoryIsPrivate: true }));
    expect(applied).not.toContain("github");
    expect(resolveSiteConfig(config).navbar.github).toBeNull();
  });

  test("keeps the settings when nothing was found", () => {
    const empty = discovered({ logo: null, favicon: null, primaryColor: null, socials: {}, footerGroups: [], repositoryIsPrivate: true });
    expect(applyDiscoveredBranding(undefined, "Tool", empty)).toEqual({ config: { name: "Tool" }, applied: [] });
  });
});

describe("branding step", () => {
  function api(overrides: Partial<InternalApiRpc> = {}) {
    return {
      createRepositoryReadToken: vi.fn(async () => "token"),
      storeGenerationSiteAsset: vi.fn(async () => ({ ref: `asset:${"e".repeat(64)}` })),
      addJobEvent: vi.fn(async () => ({})),
      ...overrides,
    } as unknown as InternalApiRpc;
  }
  const context = {
    project: { id: "project", name: "Tool", slug: "tool", siteId: "site", siteSlug: "tool" },
    repository: { id: "repo", fullName: "acme/tool", defaultBranch: "main", installationId: "1" },
  };

  test("does nothing unless the site holds only starter content", async () => {
    const env = { API: api() };
    const fetcher = vi.fn<Fetcher>();
    const result = await runSiteBrandingStep({ env, jobId: "job", context: { ...context, brandingEligible: false }, fetch: fetcher });
    expect(result).toEqual({ siteConfig: null });
    expect(fetcher).not.toHaveBeenCalled();
    expect(env.API.createRepositoryReadToken).not.toHaveBeenCalled();
  });

  test("can be turned off", async () => {
    const env = { API: api(), DOXA_SITE_BRANDING_ENABLED: "0" };
    const result = await runSiteBrandingStep({ env, jobId: "job", context: { ...context, brandingEligible: true }, fetch: vi.fn<Fetcher>() });
    expect(result).toEqual({ siteConfig: null });
  });

  test("stores assets for the job and records what it filled", async () => {
    const env = { API: api() };
    const web = fakeWeb(acmeRoutes());
    const result = await runSiteBrandingStep({ env, jobId: "job", context: { ...context, brandingEligible: true }, fetch: web.fetcher });
    expect(result.siteConfig).not.toBeNull();
    expect(env.API.storeGenerationSiteAsset).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job", kind: "logo" }));
    expect(env.API.addJobEvent).toHaveBeenCalledWith("job", expect.objectContaining({
      type: "site_branding_applied",
      data: expect.objectContaining({ contextDev: "disabled", logoSource: "homepage_header" }),
    }));
  });

  test("keeps the settings when discovery fails", async () => {
    const env = { API: api({ createRepositoryReadToken: vi.fn(async () => { throw new Error("no token"); }) }) };
    const result = await runSiteBrandingStep({ env, jobId: "job", context: { ...context, brandingEligible: true }, fetch: vi.fn<Fetcher>() });
    expect(result).toEqual({ siteConfig: null });
  });

  test("Context.dev needs both the flag and the key", () => {
    expect(contextDevApiKey({ API: api() })).toBeNull();
    expect(contextDevApiKey({ API: api(), CONTEXT_DEV_API_KEY: "key" })).toBeNull();
    expect(contextDevApiKey({ API: api(), BRANDING_CONTEXT_DEV_ENABLED: "true" })).toBeNull();
    expect(contextDevApiKey({ API: api(), BRANDING_CONTEXT_DEV_ENABLED: "true", CONTEXT_DEV_API_KEY: "key" })).toBe("key");
  });
});
