import { fetchPublic, type Fetcher } from "./fetch";
import {
  anchors,
  elements,
  findTags,
  jsonLdBlocks,
  parseAttributes,
  stripComments,
  textContent,
} from "./html";
import { isSocialHost } from "./socials";
import type { FooterGroup, LogoCandidate } from "./types";

export interface HomepageSignals {
  url: string;
  logoCandidates: LogoCandidate[];
  favicons: string[];
  /** Every absolute link on the page, JSON-LD `sameAs` first. */
  links: string[];
  footerGroups: FooterGroup[];
}

const MAX_HTML_BYTES = 2_000_000;
const MAX_FOOTER_GROUPS = 4;
const MAX_FOOTER_LINKS = 6;

/**
 * Hosts that a repository may name as its homepage but that are not the
 * project's own site: package registries, code hosts and Doxa itself.
 */
const NOT_A_BRAND_HOME = /(?:^|\.)(?:github\.com|gitlab\.com|bitbucket\.org|npmjs\.com|npmjs\.org|pypi\.org|crates\.io|docs\.rs|pkg\.go\.dev|rubygems\.org|packagist\.org|nuget\.org|hex\.pm|doxa\.page|doxa\.so)$/i;

/** The homepage URL to read, or null when the value is not a brand site. */
export function brandHomepageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withProtocol);
    if (NOT_A_BRAND_HOME.test(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export async function readHomepageSignals(
  fetcher: Fetcher,
  homepage: string,
): Promise<HomepageSignals | null> {
  const page = await fetchPublic(fetcher, homepage, {
    maxBytes: MAX_HTML_BYTES,
    timeoutMs: 12_000,
    accept: "text/html,application/xhtml+xml",
  });
  if (!page || !/html/i.test(page.contentType)) return null;
  const html = stripComments(new TextDecoder().decode(page.bytes));
  const base = page.url;
  const absolute = (href: string | undefined) => {
    if (!href) return null;
    try {
      const url = new URL(href, base);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
    } catch {
      return null;
    }
  };

  const ld = readJsonLd(html);
  const candidates: LogoCandidate[] = [];
  const header = headerLogo(html, base);
  if (header) candidates.push(header);
  const ldLogo = absolute(ld.logos[0]);
  if (ldLogo) candidates.push({ source: "json_ld", light: { kind: "url", url: ldLogo }, dark: null });

  const links = [
    ...ld.sameAs.map(absolute),
    ...anchors(html).map((anchor) => absolute(anchor.href)),
  ].filter((href): href is string => href !== null);

  return {
    url: base,
    logoCandidates: candidates,
    favicons: favicons(html, base),
    links,
    footerGroups: footerGroups(html, base),
  };
}

function readJsonLd(html: string): { logos: string[]; sameAs: string[] } {
  const out = { logos: [] as string[], sameAs: [] as string[] };
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const record = node as Record<string, unknown>;
    const type = ([] as unknown[]).concat(record["@type"] ?? []).join(",");
    if (/Organization|Corporation|Brand/.test(type)) {
      const logo = record.logo;
      const url = typeof logo === "string" ? logo : (logo as { url?: unknown } | undefined)?.url;
      if (typeof url === "string") out.logos.push(url);
      for (const same of ([] as unknown[]).concat(record.sameAs ?? [])) {
        if (typeof same === "string") out.sameAs.push(same);
      }
    }
    Object.values(record).forEach(visit);
  };
  jsonLdBlocks(html).forEach(visit);
  return out;
}

const LOGO_HINT = /logo|brand|wordmark/i;
const DARK_HINT = /dark|white|inverse|inverted/i;

function headerLogo(html: string, base: string): LogoCandidate | null {
  const origin = new URL(base).origin;
  const homeLinks: string[] = [];
  for (const match of html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
    const open = parseAttributes(match[0].slice(0, match[0].indexOf(">") + 1));
    try {
      const url = new URL(open.href ?? "", base);
      if (url.origin === origin && (url.pathname === "/" || url.pathname === "")) homeLinks.push(match[0]);
    } catch {
      // Skip the link.
    }
    if (homeLinks.length >= 3) break;
  }
  const scopes = [
    ...homeLinks.map((fragment) => ({ fragment, isHomeLink: true })),
    ...[...elements(html, "header"), ...elements(html, "nav")].slice(0, 3).map((fragment) => ({ fragment, isHomeLink: false })),
  ];
  for (const { fragment, isHomeLink } of scopes) {
    const images = findTags(fragment, "img").filter((image) => image.src);
    const image =
      images.find((i) => LOGO_HINT.test(`${i.src} ${i.alt ?? ""} ${i.class ?? ""}`) && !DARK_HINT.test(`${i.src} ${i.class ?? ""}`)) ??
      images.find((i) => LOGO_HINT.test(`${i.src} ${i.alt ?? ""} ${i.class ?? ""}`)) ??
      (isHomeLink ? images[0] : undefined);
    if (image?.src) {
      const dark = images.find((i) => i !== image && DARK_HINT.test(`${i.src} ${i.class ?? ""}`));
      return {
        source: "homepage_header",
        light: { kind: "url", url: new URL(image.src, base).href },
        dark: dark?.src ? { kind: "url", url: new URL(dark.src, base).href } : null,
      };
    }
    const svgs = elements(fragment, "svg");
    const svg = isHomeLink
      ? svgs[0]
      : svgs.find((s) => LOGO_HINT.test(s.slice(0, s.indexOf(">") + 1)));
    if (svg && svg.length > 300) {
      return { source: "homepage_header", light: { kind: "inline", svg: standaloneSvg(svg) }, dark: null };
    }
  }
  return null;
}

function standaloneSvg(svg: string): string {
  return /<svg\b[^>]*\bxmlns=/i.test(svg)
    ? svg
    : svg.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
}

function favicons(html: string, base: string): string[] {
  const icons = findTags(html, "link").filter((link) => /\bicon\b/i.test(link.rel ?? "") && link.href);
  const rank = (link: Record<string, string>) => {
    const type = (link.type ?? "").toLowerCase();
    const href = link.href.toLowerCase();
    if (type.includes("svg") || href.endsWith(".svg")) return 0;
    if (/apple-touch-icon/i.test(link.rel ?? "")) return 1;
    if (type.includes("png") || href.endsWith(".png")) return 2;
    return 3;
  };
  const ordered = icons
    .sort((a, b) => rank(a) - rank(b))
    .map((link) => {
      try {
        return new URL(link.href, base).href;
      } catch {
        return null;
      }
    })
    .filter((href): href is string => href !== null);
  ordered.push(new URL("/favicon.ico", base).href);
  return [...new Set(ordered)];
}

function siteKey(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "").split(".").slice(-2).join(".");
}

/**
 * Footer link groups: each list in the page footer, titled by the text that
 * comes right before it. Only links of the same site are kept.
 */
export function footerGroups(html: string, base: string): FooterGroup[] {
  const footer = elements(html, "footer").at(-1);
  if (!footer) return [];
  const site = siteKey(new URL(base).hostname);
  const seen = new Set<string>();
  const groups: FooterGroup[] = [];
  let cursor = 0;
  for (const list of elements(footer, "ul")) {
    const index = footer.indexOf(list, cursor);
    cursor = index + list.length;
    const before = footer.slice(Math.max(0, index - 600), index);
    const lastListEnd = before.lastIndexOf("</ul>");
    const afterLastList = lastListEnd < 0 ? before : before.slice(lastListEnd + "</ul>".length);
    const texts = afterLastList
      .split(/<[^>]+>/)
      .map((text) => textContent(text))
      .filter((text) => text.length >= 2 && text.length <= 40);
    const title = texts.at(-1);
    if (!title) continue;
    const links = [];
    for (const anchor of anchors(list)) {
      let url: URL;
      try {
        url = new URL(anchor.href, base);
      } catch {
        continue;
      }
      if (url.protocol !== "https:" || isSocialHost(url.hostname)) continue;
      if (siteKey(url.hostname) !== site) continue;
      const label = anchor.text.trim();
      if (!label || label.length > 40 || seen.has(url.href)) continue;
      seen.add(url.href);
      links.push({ label, href: url.href });
      if (links.length >= MAX_FOOTER_LINKS) break;
    }
    if (links.length >= 2) groups.push({ title, links });
    if (groups.length >= MAX_FOOTER_GROUPS) break;
  }
  return groups;
}
