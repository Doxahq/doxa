import {
  docsHostResolutionSchema,
  type InternalApiRpc,
} from "@doxahq/contracts";
import { parseDocsManifestText, type DocsManifest } from "@doxahq/docs-engine";
import { WorkerEntrypoint } from "cloudflare:workers";
import { serveSiteAsset, handleSiteAssetRequest } from "./site-assets";
import { handleVersionAssetRequest, serveVersionAsset } from "./version-assets";
import {
  DocsResolverClient,
  type DocsResolverBinding,
} from "@doxahq/contracts/docs-resolver";
import {
  handleRuntimeSourceRequest,
  runHostRuntimeRequest,
  runResolvedRuntimeRequest,
  type HostRuntimeRequest,
  type ResolvedRuntimeRequest,
  resolveDocsHost,
} from "./runtime-source";
import { artifactReader } from "./artifact-storage";

interface Env {
  DOCS_RESOLVER?: DocsResolverBinding;
  API?: InternalApiRpc;
  API_BASE_URL?: string;
  ALLOW_INTERNAL_HTTP?: string;
  DOCS_BUCKET: R2Bucket;
  DOCS_CONTENT_TOKEN?: string;
  DOCS_PUBLIC_BASE_URL?: string;
}

export class RuntimeSourceApi extends WorkerEntrypoint<Env> {
  async asset(input: {
    resolution?: unknown;
    hostname?: string;
    hash: string;
  }): Promise<Response> {
    const resolution =
      input.resolution ??
      (input.hostname ? await resolveDocsHost(this.env, input.hostname) : null);
    return serveSiteAsset(this.env, resolution, input.hash);
  }

  /**
   * An image of the pinned version, served at `/assets/{name}`. `version` is
   * the content hash from `?v=`, when the URL carries one.
   */
  async versionAsset(input: {
    resolution?: unknown;
    hostname?: string;
    name: string;
    version?: string | null;
  }): Promise<Response> {
    const resolution =
      input.resolution ??
      (input.hostname ? await resolveDocsHost(this.env, input.hostname) : null);
    return serveVersionAsset(
      this.env,
      resolution,
      input.name,
      input.version ?? null,
    );
  }

  request(input: ResolvedRuntimeRequest | HostRuntimeRequest) {
    return "resolution" in input
      ? runResolvedRuntimeRequest(this.env, input)
      : runHostRuntimeRequest(this.env, input);
  }
}

interface NavPage {
  title: string;
  href: string;
}

interface RouteParts {
  projectSlug: string;
  docsPath: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const assetResponse =
      (await handleSiteAssetRequest(request, env)) ??
      (await handleVersionAssetRequest(request, env));
    if (assetResponse) return assetResponse;
    // Production template deployments call this private content contract.
    // The HTML route below is retained as a lightweight preview/debug surface.
    const runtimeResponse = await handleRuntimeSourceRequest(request, env);
    if (runtimeResponse) return runtimeResponse;

    const url = new URL(request.url);
    const route = parseRoute(url.pathname);

    if (!route) {
      return html(renderLanding(), 200);
    }

    const resolution = await resolveDocsSite(env, route.projectSlug);
    if (!resolution) {
      return html(renderMissingProject(route.projectSlug), 404);
    }

    const manifest = await readManifest(env, resolution.manifestPath);
    if (!manifest) {
      return html(renderUnpublished(route.projectSlug), 404);
    }

    const page = findPage(manifest, route.docsPath);
    if (!page) {
      return html(renderMissingPage(route.projectSlug, manifest), 404);
    }

    const source = await readText(
      env,
      `${resolution.artifactPrefix}/${page.sourcePath}`,
    );
    if (!source) {
      return html(renderMissingPage(route.projectSlug, manifest), 404);
    }

    const navigation = await readNavigation(
      env,
      resolution.artifactPrefix,
      manifest,
    );
    return html(
      renderDocsPage({
        projectSlug: route.projectSlug,
        manifest,
        navigation,
        source,
        currentHref: page.href,
      }),
      200,
      {
        "cache-control": "public, max-age=60, s-maxage=300",
      },
    );
  },
};

function parseRoute(pathname: string): RouteParts | null {
  const segments = pathname.split("/").filter(Boolean);
  const projectSlug = segments[0];
  if (!projectSlug) return null;

  return {
    projectSlug,
    docsPath: `/${segments.slice(1).join("/")}`.replace(/\/$/, "") || "/",
  };
}

async function resolveDocsSite(env: Env, projectSlug: string) {
  if (env.DOCS_RESOLVER) {
    return new DocsResolverClient(env.DOCS_RESOLVER).resolveDocsSite(
      projectSlug,
    );
  }
  const path = `/internal/docs-sites/${encodeURIComponent(projectSlug)}`;
  if (env.API) {
    try {
      return await env.API.resolveDocsSite(projectSlug);
    } catch {
      if (!isInternalHttpFallbackAllowed(env)) return null;
    }
  }

  const response = await fetchFromApiBaseUrl(env, path);
  if (!response.ok) return null;

  const payload = (await response.json()) as unknown;
  const parsed = docsHostResolutionSchema.safeParse(
    (payload as { site?: unknown }).site,
  );
  return parsed.success ? parsed.data : null;
}

function fetchFromApiBaseUrl(env: Env, path: string): Promise<Response> {
  const baseUrl = env.API_BASE_URL ?? "http://localhost:8787";
  return fetch(`${baseUrl.replace(/\/+$/, "")}${path}`);
}

async function readManifest(
  env: Env,
  path: string,
): Promise<DocsManifest | null> {
  const raw = await readText(env, path);
  if (!raw) return null;

  const parsed = parseDocsManifestText(raw);
  return parsed.ok ? parsed.manifest : null;
}

async function readText(env: Env, path: string): Promise<string | null> {
  const object = await artifactReader(env.DOCS_BUCKET).get(path);
  if (object) return object.text();

  if (env.API) {
    try {
      const rpcArtifact = await env.API.readDocsArtifact(path);
      return rpcArtifact?.text ?? null;
    } catch {
      if (!isInternalHttpFallbackAllowed(env)) return null;
    }
  }

  const response = await fetchFromApiBaseUrl(
    env,
    `/internal/docs-artifacts?path=${encodeURIComponent(path)}`,
  );
  return response.ok ? response.text() : null;
}

function isInternalHttpFallbackAllowed(env: Env): boolean {
  return env.ALLOW_INTERNAL_HTTP === "true";
}

async function readNavigation(
  env: Env,
  artifactPrefix: string,
  manifest: DocsManifest,
): Promise<NavPage[]> {
  const raw = await readText(env, `${artifactPrefix}/settings/documents.json`);
  if (!raw) return manifest.pages;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return manifest.pages;
    const pages = parsed.filter(isNavPage);
    return pages.length > 0 ? pages : manifest.pages;
  } catch {
    return manifest.pages;
  }
}

function findPage(manifest: DocsManifest, docsPath: string) {
  return manifest.pages.find((page) => page.href === docsPath) ?? null;
}

function html(body: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...headers,
    },
  });
}

function renderLanding(): string {
  return layout({
    title: "Doxa Docs Runtime",
    body: `
      <section class="empty">
        <p class="eyebrow">DOXA DOCS</p>
        <h1>Docs runtime content API</h1>
        <p>Use <code>/runtime-source</code> from the shared docs template, or open <code>/project-slug</code> for a local preview.</p>
      </section>
    `,
  });
}

function renderMissingProject(projectSlug: string): string {
  return layout({
    title: "Docs not found",
    body: `
      <section class="empty">
        <p class="eyebrow">404</p>
        <h1>No published docs for ${escapeHtml(projectSlug)}</h1>
        <p>The project either does not exist or has not published its first docs version yet.</p>
      </section>
    `,
  });
}

function renderUnpublished(projectSlug: string): string {
  return layout({
    title: "Docs unpublished",
    body: `
      <section class="empty">
        <p class="eyebrow">UNPUBLISHED</p>
        <h1>${escapeHtml(projectSlug)} is not live yet</h1>
        <p>Generate and publish docs from the Doxa dashboard to make this path available.</p>
      </section>
    `,
  });
}

function renderMissingPage(
  projectSlug: string,
  manifest: DocsManifest,
): string {
  return layout({
    title: "Page not found",
    body: `
      <aside>${renderNav(projectSlug, manifest.pages, "")}</aside>
      <article>
        <p class="eyebrow">404</p>
        <h1>Page not found</h1>
        <p>This page is not part of the current published docs version.</p>
      </article>
    `,
  });
}

function renderDocsPage(input: {
  projectSlug: string;
  manifest: DocsManifest;
  navigation: NavPage[];
  source: string;
  currentHref: string;
}): string {
  const rendered = renderMarkdown(input.source);
  return layout({
    title: rendered.title ?? input.manifest.projectSlug,
    body: `
      <aside>${renderNav(input.projectSlug, input.navigation, input.currentHref)}</aside>
      <article>${rendered.html}</article>
    `,
  });
}

function renderNav(
  projectSlug: string,
  pages: NavPage[],
  currentHref: string,
): string {
  const items = pages
    .map((page) => {
      const href = `/${projectSlug}${page.href === "/" ? "" : page.href}`;
      const active = page.href === currentHref ? "active" : "";
      return `<a class="${active}" href="${href}">${escapeHtml(page.title)}</a>`;
    })
    .join("");

  return `<nav><strong>${escapeHtml(projectSlug)}</strong>${items}</nav>`;
}

export function renderMarkdown(source: string): {
  html: string;
  title?: string;
  description?: string;
} {
  const { content, frontmatter } = extractFrontmatter(source);
  // This debug preview renders escaped HTML and cannot render components.
  // Remove component tags here, not in the generator: the public renderer
  // needs them to construct the registered runtime components.
  const withoutComponents = content.replace(
    /<\/?[A-Z][A-Za-z0-9]*(?:\s[^>]*)?>/g,
    "",
  );
  const lines = withoutComponents.split(/\r?\n/);
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const language = trimmed.slice(3).trim().split(/\s+/)[0] ?? "";
      const code: string[] = [];
      index += 1;
      while (
        index < lines.length &&
        !(lines[index] ?? "").trim().startsWith("```")
      ) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      const className = language
        ? ` class="language-${escapeAttribute(language)}"`
        : "";
      out.push(
        `<pre><code${className}>${escapeHtml(code.join("\n"))}</code></pre>`,
      );
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const table = consumeTable(lines, index);
      out.push(table.html);
      index = table.nextIndex;
      continue;
    }

    const unordered = consumeList(lines, index, "ul");
    if (unordered) {
      out.push(unordered.html);
      index = unordered.nextIndex;
      continue;
    }

    const ordered = consumeList(lines, index, "ol");
    if (ordered) {
      out.push(ordered.html);
      index = ordered.nextIndex;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && shouldContinueParagraph(lines, index)) {
      paragraph.push((lines[index] ?? "").trim());
      index += 1;
    }
    out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
  }

  return {
    html: out.join("\n"),
    title: frontmatter.title,
    description: frontmatter.description,
  };
}

function isNavPage(value: unknown): value is NavPage {
  const candidate = value as Partial<NavPage> | null;
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    typeof candidate.title === "string" &&
    typeof candidate.href === "string"
  );
}

function extractFrontmatter(source: string): {
  content: string;
  frontmatter: { title?: string; description?: string };
} {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*/.exec(source);
  if (!match) return { content: source, frontmatter: {} };

  const frontmatter: { title?: string; description?: string } = {};
  for (const line of match[1].split(/\r?\n/)) {
    const parsed = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!parsed) continue;
    const key = parsed[1];
    const value = parsed[2].replace(/^['"]|['"]$/g, "").trim();
    if (key === "title") frontmatter.title = value;
    if (key === "description") frontmatter.description = value;
  }

  return { content: source.slice(match[0].length), frontmatter };
}

function shouldContinueParagraph(lines: string[], index: number): boolean {
  const current = (lines[index] ?? "").trim();
  if (!current) return false;
  if (current.startsWith("```")) return false;
  if (/^(#{1,4})\s+/.test(current)) return false;
  if (/^[-*]\s+/.test(current)) return false;
  if (/^\d+\.\s+/.test(current)) return false;
  if (isTableStart(lines, index)) return false;
  return true;
}

function consumeList(
  lines: string[],
  index: number,
  tag: "ul" | "ol",
): { html: string; nextIndex: number } | null {
  const pattern = tag === "ul" ? /^[-*]\s+(.+)$/ : /^\d+\.\s+(.+)$/;
  if (!pattern.test((lines[index] ?? "").trim())) return null;

  const items: string[] = [];
  let nextIndex = index;
  while (nextIndex < lines.length) {
    const match = pattern.exec((lines[nextIndex] ?? "").trim());
    if (!match) break;
    items.push(`<li>${renderInline(match[1])}</li>`);
    nextIndex += 1;
  }

  return { html: `<${tag}>${items.join("")}</${tag}>`, nextIndex };
}

function isTableStart(lines: string[], index: number): boolean {
  const header = (lines[index] ?? "").trim();
  const separator = (lines[index + 1] ?? "").trim();
  if (!header.includes("|") || !separator.includes("|")) return false;
  return splitTableRow(separator).every((cell) =>
    /^:?-{3,}:?$/.test(cell.trim()),
  );
}

function consumeTable(
  lines: string[],
  index: number,
): { html: string; nextIndex: number } {
  const headers = splitTableRow(lines[index] ?? "");
  let nextIndex = index + 2;
  const rows: string[][] = [];

  while (nextIndex < lines.length) {
    const line = (lines[nextIndex] ?? "").trim();
    if (!line.includes("|")) break;
    rows.push(splitTableRow(line));
    nextIndex += 1;
  }

  const head = headers
    .map((header) => `<th>${renderInline(header.trim())}</th>`)
    .join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${renderInline(cell.trim())}</td>`).join("")}</tr>`,
    )
    .join("");

  return {
    html: `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
    nextIndex,
  };
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
}

function renderInline(value: string): string {
  let out = "";
  let index = 0;

  while (index < value.length) {
    const char = value[index];

    if (char === "`") {
      const end = value.indexOf("`", index + 1);
      if (end !== -1) {
        out += `<code>${escapeHtml(value.slice(index + 1, end))}</code>`;
        index = end + 1;
        continue;
      }
    }

    if (char === "[") {
      const labelEnd = value.indexOf("](", index + 1);
      if (labelEnd !== -1) {
        const hrefEnd = value.indexOf(")", labelEnd + 2);
        if (hrefEnd !== -1) {
          const label = value.slice(index + 1, labelEnd);
          const href = sanitizeHref(value.slice(labelEnd + 2, hrefEnd));
          out += `<a href="${escapeAttribute(href)}">${escapeHtml(label)}</a>`;
          index = hrefEnd + 1;
          continue;
        }
      }
    }

    out += escapeHtml(char);
    index += 1;
  }

  return out;
}

function sanitizeHref(value: string): string {
  const trimmed = value.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (
    trimmed.startsWith("#") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../")
  ) {
    return trimmed;
  }
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) return trimmed;
  return "#";
}

function layout(input: { title: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(input.title)} - Doxa Docs</title>
  <style>
    :root { color-scheme: dark; background: #000; color: #f3f3f3; font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
    body { margin: 0; min-height: 100vh; background: #000; }
    body::before { content: ""; position: fixed; inset: 0; pointer-events: none; background-image: linear-gradient(rgba(255,255,255,.07) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.07) 1px, transparent 1px); background-size: 60px 60px; mask-image: linear-gradient(to bottom, black, transparent 75%); }
    main { display: grid; grid-template-columns: 260px minmax(0, 820px); gap: 48px; max-width: 1180px; margin: 0 auto; padding: 48px 24px; position: relative; }
    aside { border-right: 1px solid rgba(255,255,255,.14); min-height: calc(100vh - 96px); }
    nav { display: flex; flex-direction: column; gap: 8px; padding-right: 24px; position: sticky; top: 32px; }
    nav strong { margin-bottom: 16px; text-transform: uppercase; letter-spacing: .08em; font-size: 13px; }
    nav a { color: rgba(255,255,255,.62); text-decoration: none; border: 1px solid transparent; padding: 8px 10px; font-size: 13px; overflow-wrap: anywhere; }
    nav a:hover, nav a.active { color: white; border-color: rgba(255,255,255,.18); background: rgba(255,255,255,.05); }
    article { min-width: 0; }
    h1 { font-size: clamp(36px, 7vw, 72px); line-height: .92; letter-spacing: 0; margin: 0 0 28px; text-transform: uppercase; }
    h2 { margin-top: 42px; border-top: 1px solid rgba(255,255,255,.16); padding-top: 24px; text-transform: uppercase; }
    h3 { margin-top: 28px; }
    p, li { color: rgba(255,255,255,.72); line-height: 1.8; }
    a { color: #4da3ff; text-decoration: underline; text-underline-offset: 3px; }
    ul, ol { margin: 18px 0 24px; padding-left: 24px; }
    li { margin: 6px 0; }
    code { border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06); padding: 2px 5px; }
    pre { border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.045); padding: 18px; overflow: auto; }
    pre code { border: 0; padding: 0; background: transparent; }
    .table-wrap { overflow-x: auto; margin: 24px 0; border: 1px solid rgba(255,255,255,.14); }
    table { width: 100%; border-collapse: collapse; min-width: 520px; }
    th, td { border-bottom: 1px solid rgba(255,255,255,.12); padding: 12px 14px; text-align: left; vertical-align: top; }
    th { color: white; text-transform: uppercase; font-size: 12px; }
    .li::before { content: "- "; color: #4f8cff; }
    .empty { max-width: 820px; margin: 18vh auto 0; padding: 0 24px; }
    .eyebrow { color: #4f8cff; font-size: 12px; letter-spacing: .16em; text-transform: uppercase; }
    @media (max-width: 820px) { main { display: block; padding: 28px 18px; } aside { border-right: 0; min-height: auto; margin-bottom: 32px; } nav { position: static; padding-right: 0; } }
  </style>
</head>
<body><main>${input.body}</main></body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
