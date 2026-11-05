import {
  DOCS_SEARCH_CONFIG_PATH,
  docsSearchClientConfigSchema,
  type DocsSearchClientConfig,
} from "@doxahq/contracts/docs-search";
import type { BrowserSearchEngine } from "@doxahq/docs-search/browser";

/** The site can change its version or provider while a tab stays open. */
const CONFIG_MAX_AGE_MS = 10 * 60 * 1000;
const SERVER_MODE: DocsSearchClientConfig = { mode: "server" };
const VERSION_CHANGED_STATUS = 409;

type BrowserConfig = Extract<DocsSearchClientConfig, { mode: "browser" }>;

interface CachedEngine {
  contentVersion: string;
  engine: Promise<BrowserSearchEngine | null>;
  ready: BrowserSearchEngine | null;
}

let configCache: { config: Promise<DocsSearchClientConfig>; at: number } | null =
  null;
let engineCache: CachedEngine | null = null;
/** After a version conflict the HTTP-cached config is known to be old. */
let configIsStale = false;

/** How this page searches. Any failure means the renderer's search. */
export function readSearchConfig(
  now: number = Date.now(),
): Promise<DocsSearchClientConfig> {
  if (!configCache || now - configCache.at > CONFIG_MAX_AGE_MS) {
    configCache = { config: fetchSearchConfig(), at: now };
  }
  return configCache.config;
}

async function fetchSearchConfig(): Promise<DocsSearchClientConfig> {
  try {
    const response = await fetch(DOCS_SEARCH_CONFIG_PATH, {
      headers: { accept: "application/json" },
      ...(configIsStale ? { cache: "reload" as const } : {}),
    });
    configIsStale = false;
    if (!response.ok) return SERVER_MODE;
    const parsed = docsSearchClientConfigSchema.safeParse(
      await response.json(),
    );
    return parsed.success ? parsed.data : SERVER_MODE;
  } catch {
    return SERVER_MODE;
  }
}

/** The engine, if it finished loading. It never waits for the download. */
export function readyBrowserEngine(
  config: BrowserConfig,
): BrowserSearchEngine | null {
  return engineCache?.contentVersion === config.contentVersion
    ? engineCache.ready
    : null;
}

/** Starts the download once per version. Search code loads only for this mode. */
export function loadBrowserEngine(
  config: BrowserConfig,
): Promise<BrowserSearchEngine | null> {
  if (engineCache?.contentVersion === config.contentVersion) {
    return engineCache.engine;
  }
  const entry: CachedEngine = {
    contentVersion: config.contentVersion,
    ready: null,
    engine: Promise.resolve(null),
  };
  entry.engine = downloadEngine(config).then((engine) => {
    entry.ready = engine;
    return engine;
  });
  engineCache = entry;
  return entry.engine;
}

async function downloadEngine(
  config: BrowserConfig,
): Promise<BrowserSearchEngine | null> {
  try {
    const response = await fetch(config.indexUrl);
    if (response.status === VERSION_CHANGED_STATUS) {
      forgetConfig(config);
    }
    if (!response.ok) return null;
    const [text, browser] = await Promise.all([
      response.text(),
      import("@doxahq/docs-search/browser"),
    ]);
    const engine = await browser.loadBrowserSearchEngine(text);
    if (!prefersLessData()) {
      void loadSnippets(config, engine, browser.parseSnippets);
    }
    return engine;
  } catch (error) {
    console.warn("[search] browser index failed", error);
    return null;
  }
}

/**
 * The site published a new version: the next search asks for the new config,
 * past the browser's HTTP cache, and can download again.
 */
function forgetConfig(config: BrowserConfig): void {
  configCache = null;
  configIsStale = true;
  if (engineCache?.contentVersion === config.contentVersion) engineCache = null;
}

/** Search works without snippets, so this file comes second and may fail. */
async function loadSnippets(
  config: BrowserConfig,
  engine: BrowserSearchEngine,
  parse: (text: string) => ReturnType<typeof import("@doxahq/docs-search/browser").parseSnippets>,
): Promise<void> {
  try {
    const response = await fetch(config.snippetsUrl);
    if (response.status === VERSION_CHANGED_STATUS) {
      configCache = null;
      configIsStale = true;
    }
    if (!response.ok) return;
    const snippets = parse(await response.text());
    if (snippets) engine.addSnippets(snippets);
  } catch {
    // Results keep their summary line.
  }
}

interface NetworkInformation {
  saveData?: boolean;
  effectiveType?: string;
}

/** Data saver or a 2G connection: download only after the visitor asks. */
export function prefersLessData(): boolean {
  if (typeof navigator === "undefined") return false;
  const connection = (navigator as Navigator & { connection?: NetworkInformation })
    .connection;
  return (
    connection?.saveData === true ||
    connection?.effectiveType === "2g" ||
    connection?.effectiveType === "slow-2g"
  );
}

/** Forgets the loaded state. For tests. */
export function resetSearchSession(): void {
  configCache = null;
  engineCache = null;
  configIsStale = false;
}
