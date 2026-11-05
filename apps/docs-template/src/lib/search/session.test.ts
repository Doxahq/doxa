import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { compileSearchArtifact } from "@doxahq/docs-search";
import { splitCompiledSearchIndex } from "@doxahq/docs-search/browser-artifacts";

import { isSearchInstant, preloadSearch, searchDocs } from "./index";
import { resetSearchSession } from "./session";

const artifact = {
  schemaVersion: 1 as const,
  contentVersion: "v1",
  documents: [
    {
      id: "/deploy",
      slug: "/deploy",
      title: "Deployment",
      description: "How to deploy.",
      breadcrumb: [],
      section: "default",
      headings: [],
      keywords: [],
      content: "deploy to cloudflare",
      lines: [{ text: "Deploy to Cloudflare", anchor: "cf" }],
    },
  ],
};
const files = splitCompiledSearchIndex(
  JSON.stringify(compileSearchArtifact(artifact)),
)!;
const serverHit = {
  id: "/server",
  slug: "/server",
  title: "Server",
  breadcrumb: [],
  snippetLine: "from the server",
  score: 1,
  terms: [],
};

type Routes = Record<string, () => Response | Promise<Response>>;

function route(routes: Routes) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const key = Object.keys(routes).find((path) => url.startsWith(path));
    if (!key) throw new Error(`Unexpected fetch: ${url}`);
    return routes[key]!();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const browserConfig = {
  mode: "browser",
  contentVersion: "v1",
  indexUrl: "/_doxa/search/v1/index?v=v1",
  snippetsUrl: "/_doxa/search/v1/snippets?v=v1",
};
const CONFIG = "/_doxa/search/v1/config";
const SERVER = "/api/search";

beforeEach(() => resetSearchSession());
afterEach(() => vi.unstubAllGlobals());

describe("docs search session", () => {
  it("uses the renderer when the config is missing", async () => {
    route({
      [CONFIG]: () => new Response(null, { status: 404 }),
      [SERVER]: () => Response.json({ results: [serverHit] }),
    });
    expect((await searchDocs("deploy"))[0]?.slug).toBe("/server");
  });

  it("uses the renderer while the index downloads, then the browser", async () => {
    let finish: (response: Response) => void = () => {};
    const fetchMock = route({
      [CONFIG]: () => Response.json(browserConfig),
      "/_doxa/search/v1/index": () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
      "/_doxa/search/v1/snippets": () => new Response(files.snippets),
      [SERVER]: () => Response.json({ results: [serverHit] }),
    });

    expect((await searchDocs("deploy"))[0]?.slug).toBe("/server");
    expect(await isSearchInstant()).toBe(false);

    finish(new Response(files.index));
    await vi.waitFor(async () => expect(await isSearchInstant()).toBe(true));

    const before = fetchMock.mock.calls.filter(([url]) => String(url).startsWith(SERVER)).length;
    expect((await searchDocs("deploymnt"))[0]?.slug).toBe("/deploy");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith(SERVER))).toHaveLength(before);
  });

  it("keeps using the renderer when the index fails", async () => {
    route({
      [CONFIG]: () => Response.json(browserConfig),
      "/_doxa/search/v1/index": () => new Response(null, { status: 413 }),
      [SERVER]: () => Response.json({ results: [serverHit] }),
    });
    await preloadSearch();
    expect((await searchDocs("deploy"))[0]?.slug).toBe("/server");
  });

  it("asks for a fresh config and downloads again after a new publish", async () => {
    const nextConfig = {
      ...browserConfig,
      contentVersion: "v2",
      indexUrl: "/_doxa/search/v1/index?v=v2",
      snippetsUrl: "/_doxa/search/v1/snippets?v=v2",
    };
    // The browser's HTTP cache answers with the old config unless told not to.
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === CONFIG) {
        return Response.json(init?.cache === "reload" ? nextConfig : browserConfig);
      }
      if (url === browserConfig.indexUrl) return new Response(null, { status: 409 });
      if (url === nextConfig.indexUrl) return new Response(files.index);
      if (url === nextConfig.snippetsUrl) return new Response(files.snippets);
      return Response.json({ results: [serverHit] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await preloadSearch();
    await preloadSearch();
    await vi.waitFor(async () => expect(await isSearchInstant()).toBe(true));
    expect((await searchDocs("deploy"))[0]?.slug).toBe("/deploy");

    // The stale flag lasts for one fetch only.
    const configCalls = fetchMock.mock.calls.filter(([url]) => String(url) === CONFIG);
    expect(configCalls.map(([, init]) => init?.cache)).toEqual([undefined, "reload"]);
  });

  it("can download the same version again after a conflict", async () => {
    let conflicts = 1;
    const fetchMock = route({
      [CONFIG]: () => Response.json(browserConfig),
      "/_doxa/search/v1/index": () => {
        if (conflicts > 0) {
          conflicts -= 1;
          return new Response(null, { status: 409 });
        }
        return new Response(files.index);
      },
      "/_doxa/search/v1/snippets": () => new Response(files.snippets),
    });
    await preloadSearch();
    await preloadSearch();
    await vi.waitFor(async () => expect(await isSearchInstant()).toBe(true));
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url) === browserConfig.indexUrl),
    ).toHaveLength(2);
  });

  it("keeps the summary line when the snippets belong to a newer version", async () => {
    const fetchMock = route({
      [CONFIG]: () => Response.json(browserConfig),
      "/_doxa/search/v1/index": () => new Response(files.index),
      "/_doxa/search/v1/snippets": () => new Response(null, { status: 409 }),
    });
    await preloadSearch();
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(browserConfig.snippetsUrl),
    );
    expect((await searchDocs("deploy"))[0]).toMatchObject({
      slug: "/deploy",
      snippetLine: "Deploy to Cloudflare",
    });
  });

  it("downloads nothing on data saver until the visitor asks", async () => {
    vi.stubGlobal("navigator", { connection: { saveData: true } });
    const fetchMock = route({
      [CONFIG]: () => Response.json(browserConfig),
      "/_doxa/search/v1/index": () => new Response(files.index),
    });
    await preloadSearch();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([CONFIG]);

    await preloadSearch({ visitorAsked: true });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      CONFIG,
      browserConfig.indexUrl,
    ]);
  });

  it("asks the gateway with no credentials and no site parameter", async () => {
    const fetchMock = route({
      [CONFIG]: () =>
        Response.json({ mode: "gateway", endpoint: "https://lexis.doxa.so/v1/search" }),
      "https://lexis.doxa.so": () => Response.json({ results: [serverHit] }),
    });
    await searchDocs("deploy");
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("https://lexis.doxa.so/v1/search?q=deploy&limit=8");
    expect(init.credentials).toBe("omit");
    expect(init.headers).toBeUndefined();
  });

  it("falls back to the renderer when the gateway fails", async () => {
    for (const gateway of [
      () => Response.json({ error: "index_not_ready" }, { status: 503 }),
      () => Promise.reject(new TypeError("network")),
      () => Response.json({ wrong: true }),
    ]) {
      resetSearchSession();
      route({
        [CONFIG]: () =>
          Response.json({ mode: "gateway", endpoint: "https://lexis.doxa.so/v1/search" }),
        "https://lexis.doxa.so": gateway,
        [SERVER]: () => Response.json({ results: [serverHit] }),
      });
      expect((await searchDocs("deploy"))[0]?.slug).toBe("/server");
    }
  });

  it("does not fall back after an abort", async () => {
    const fetchMock = route({
      [CONFIG]: () =>
        Response.json({ mode: "gateway", endpoint: "https://lexis.doxa.so/v1/search" }),
      "https://lexis.doxa.so": () =>
        Promise.reject(new DOMException("Aborted", "AbortError")),
    });
    expect(await searchDocs("deploy")).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores a query under two characters", async () => {
    const fetchMock = route({});
    expect(await searchDocs("d")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
