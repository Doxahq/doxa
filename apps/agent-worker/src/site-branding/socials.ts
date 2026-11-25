import { SOCIAL_KINDS, type SocialKind, type SocialLinks } from "./types";

const SOCIAL_HOSTS: Record<SocialKind, RegExp> = {
  x: /^(?:www\.)?(?:x|twitter)\.com$/,
  github: /^(?:www\.)?github\.com$/,
  linkedin: /^(?:[a-z]{2,3}\.|www\.)?linkedin\.com$/,
  discord: /^(?:www\.)?(?:discord\.(?:gg|com)|discordapp\.com)$/,
  youtube: /^(?:www\.|m\.)?(?:youtube\.com|youtu\.be)$/,
};

const SKIPPED_FIRST_SEGMENT: Partial<Record<SocialKind, ReadonlySet<string>>> = {
  x: new Set(["intent", "share", "home", "search", "hashtag", "i"]),
  github: new Set(["sponsors", "features", "about", "pricing", "login", "marketplace", "topics", "orgs"]),
  youtube: new Set(["watch", "embed", "shorts", "results"]),
  linkedin: new Set(["shareArticle", "sharing", "feed"]),
};

export function isSocialHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return SOCIAL_KINDS.some((kind) => SOCIAL_HOSTS[kind].test(host));
}

/** A profile link of a known network, normalized to https without query. */
export function socialLink(href: string): { kind: SocialKind; url: string } | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  for (const kind of SOCIAL_KINDS) {
    if (!SOCIAL_HOSTS[kind].test(url.hostname.toLowerCase())) continue;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length === 0 && kind !== "discord") return null;
    if (kind === "discord" && segments.length === 0) return null;
    if (SKIPPED_FIRST_SEGMENT[kind]?.has(segments[0])) return null;
    if (kind === "x" && segments.length > 1) return null;
    const path = kind === "github" ? `/${segments[0]}` : `/${segments.join("/")}`;
    return { kind, url: `https://${url.hostname.toLowerCase()}${path}` };
  }
  return null;
}

/** Adds the first link of each kind; earlier sources win. */
export function collectSocials(target: SocialLinks, hrefs: Iterable<string>): void {
  for (const href of hrefs) {
    const link = socialLink(href);
    if (link && !target[link.kind]) target[link.kind] = link.url;
  }
}
