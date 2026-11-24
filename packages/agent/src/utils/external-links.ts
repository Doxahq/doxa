/**
 * The outside-link check. A generated page can link to a domain that the
 * repository never mentions: the model made it up, or repository text asked
 * for it in a hidden way. Owner decision (2026-10-27): outside links are
 * allowed, so the check flags such domains for the review and never removes
 * a link. It is a string scan with no network call.
 */

import { isAbsolute, relative, resolve } from "node:path";
import {
  PAGE_OPEN_ISSUE_LIMITS,
  UNVERIFIED_EXTERNAL_LINK_LIMITS,
  type PageOpenIssue,
} from "@doxahq/contracts/generation-reviews";
import { runCommand } from "./runtime";

/** The open-issue check id of a page that links to an unverified domain. */
export const UNVERIFIED_EXTERNAL_LINK_CHECK = "unverified-external-link";

/** At most this many domains of one page are checked and flagged. */
export const MAX_UNVERIFIED_DOMAINS_PER_PAGE = UNVERIFIED_EXTERNAL_LINK_LIMITS.domainsPerPage;

const REPOSITORY_SCAN_TIMEOUT_MS = 20_000;
const EXCLUDED_DIRECTORIES = [".git", "node_modules", ".next", ".turbo", ".wrangler", "coverage"] as const;

/**
 * An `http://` or `https://` URL anywhere in the page (Markdown links, raw
 * URLs, `src` and `href` attributes, code), or a protocol-relative `//host`
 * in a link or an attribute. Group 1 is the authority: userinfo, host, port.
 */
const ABSOLUTE_URL_PATTERN = /\bhttps?:\/\/([^\s/?#"'`<>()[\]{}\\|^]+)/gi;
const PROTOCOL_RELATIVE_URL_PATTERN = /(?:\]\(|=\s*["'{]?\s*)\/\/([^\s/?#"'`<>()[\]{}\\|^]+)/gi;

/** The host of a URL authority, lowercase and in ASCII, or null when it is not a host. */
function hostOfAuthority(authority: string): string | null {
  try {
    // A sentence can end right after a URL, so its last punctuation is not part of the host.
    const host = new URL(`https://${authority.replace(/[.,;:!]+$/, "")}`).hostname.replace(/\.$/, "").toLowerCase();
    // A name with a dot, or an IPv4 address. `localhost` is not an outside host.
    return /^[a-z0-9.-]+$/.test(host) && host.includes(".") && host.length <= UNVERIFIED_EXTERNAL_LINK_LIMITS.domainLength
      ? host
      : null;
  } catch {
    return null;
  }
}

/** The distinct outside domains that a page links to or loads, in the order they first appear. */
export function externalDomainsOf(content: string): string[] {
  const domains = new Set<string>();
  for (const pattern of [ABSOLUTE_URL_PATTERN, PROTOCOL_RELATIVE_URL_PATTERN]) {
    for (const match of content.matchAll(pattern)) {
      const host = hostOfAuthority(match[1] ?? "");
      if (host) domains.add(host);
    }
  }
  return [...domains];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The domain as a whole name: no letter, digit or hyphen right before it,
 * and no more name after it. A dot that ends a sentence still matches.
 */
function domainPattern(domain: string): string {
  return `(^|[^a-z0-9-])${escapeRegExp(domain)}($|[^a-z0-9.-]|\\.($|[^a-z0-9-]))`;
}

function isInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

export interface RepositoryDomainIndex {
  /**
   * The domains of `domains` that no repository file contains. A domain
   * whose scan failed is not returned: the check flags only what it knows.
   */
  unverified(domains: readonly string[]): Promise<string[]>;
}

/**
 * Finds domains in the repository files with one `grep` call for the
 * domains not yet known, and remembers each answer for the whole run.
 * `excludedRoots` are folders whose files do not count, such as the docs
 * output folder when it sits inside the repository: a page cannot verify
 * its own links.
 */
export function createRepositoryDomainIndex(input: {
  cwd: string;
  excludedRoots?: readonly string[];
}): RepositoryDomainIndex {
  const cwd = resolve(input.cwd);
  // A root that holds the whole repository would hide every file, so it is not excluded.
  const excludedRoots = (input.excludedRoots ?? [])
    .map((root) => resolve(cwd, root))
    .filter((root) => !isInside(root, cwd));
  const known = new Map<string, boolean>();

  const scan = async (domains: readonly string[]): Promise<void> => {
    const result = await runCommand([
      "grep",
      "-r",
      "-I",
      "-i",
      "-o",
      "-H",
      "--null",
      "-E",
      ...EXCLUDED_DIRECTORIES.map((directory) => `--exclude-dir=${directory}`),
      ...domains.flatMap((domain) => ["-e", domainPattern(domain)]),
      "--",
      ".",
    ], { cwd, timeoutMs: REPOSITORY_SCAN_TIMEOUT_MS });
    // grep exits 1 when nothing matched; anything else is a failed scan.
    if (result.timedOut || (result.exitCode !== 0 && result.exitCode !== 1)) return;

    const found = new Set<string>();
    for (const line of result.stdout.split("\n")) {
      const separator = line.indexOf("\0");
      if (separator < 0) continue;
      const filePath = resolve(cwd, line.slice(0, separator));
      if (excludedRoots.some((root) => isInside(root, filePath))) continue;
      const matched = line.slice(separator + 1).toLowerCase();
      for (const domain of domains) {
        if (matched.includes(domain)) found.add(domain);
      }
    }
    for (const domain of domains) known.set(domain, found.has(domain));
  };

  return {
    async unverified(domains) {
      const unknown = [...new Set(domains)].filter((domain) => !known.has(domain));
      if (unknown.length > 0) {
        try {
          await scan(unknown);
        } catch {
          // A failed scan flags nothing; the next page tries these domains again.
        }
      }
      return domains.filter((domain) => known.get(domain) === false);
    },
  };
}

/** The outside domains of a page that the repository does not contain. */
export async function unverifiedExternalDomainsOf(
  content: string,
  index: RepositoryDomainIndex,
): Promise<string[]> {
  const domains = externalDomainsOf(content).slice(0, MAX_UNVERIFIED_DOMAINS_PER_PAGE);
  return domains.length > 0 ? index.unverified(domains) : [];
}

/**
 * The open issue that the review shows for a page with unverified domains.
 * The message lists as many domains as its bound allows.
 */
export function unverifiedExternalLinkIssue(domains: readonly string[]): PageOpenIssue | null {
  if (domains.length === 0) return null;
  const lead = domains.length === 1
    ? "Links to a domain that the repository does not contain: "
    : "Links to domains that the repository does not contain: ";
  const tail = ". Check the links before you publish.";
  // Three characters stay free for a ", …" after the last domain that fits.
  const room = PAGE_OPEN_ISSUE_LIMITS.messageLength - lead.length - tail.length - 3;
  let list = "";
  for (const domain of domains) {
    const next = list ? `${list}, ${domain}` : domain;
    if (next.length > room) {
      list = list ? `${list}, …` : `${domain.slice(0, Math.max(0, room - 1))}…`;
      break;
    }
    list = next;
  }
  return { check: UNVERIFIED_EXTERNAL_LINK_CHECK, message: `${lead}${list}${tail}`, instructions: false };
}

/**
 * The page issues with the link issue added: after the instruction breaks,
 * before the other issues, within `PAGE_OPEN_ISSUE_LIMITS.issues`. A page
 * written again replaces an earlier link issue.
 */
export function withUnverifiedExternalLinkIssue(
  issues: readonly PageOpenIssue[] | undefined,
  domains: readonly string[],
): PageOpenIssue[] {
  const others = (issues ?? []).filter((issue) => issue.check !== UNVERIFIED_EXTERNAL_LINK_CHECK);
  const linkIssue = unverifiedExternalLinkIssue(domains);
  if (!linkIssue) return others;
  return [
    ...others.filter((issue) => issue.instructions),
    linkIssue,
    ...others.filter((issue) => !issue.instructions),
  ].slice(0, PAGE_OPEN_ISSUE_LIMITS.issues);
}
