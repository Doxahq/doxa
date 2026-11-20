import { parseAttributes } from "./html";
import type { Fetcher } from "./fetch";
import type { ImageLocation, LogoCandidate } from "./types";

const GITHUB_API = "https://api.github.com";

export interface RepositorySignals {
  fullName: string;
  htmlUrl: string;
  isPrivate: boolean;
  defaultBranch: string;
  homepage: string | null;
  owner: {
    login: string;
    htmlUrl: string;
    isOrganization: boolean;
    blog: string | null;
    twitter: string | null;
  };
  readme: string | null;
  readmePath: string;
  logoCandidates: LogoCandidate[];
}

export class GitHubReader {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly token: string,
  ) {}

  private headers(accept = "application/vnd.github+json"): HeadersInit {
    return {
      authorization: `Bearer ${this.token}`,
      accept,
      "user-agent": "doxa-agent-worker",
      "x-github-api-version": "2022-11-28",
    };
  }

  async json<T>(path: string): Promise<T | null> {
    try {
      const response = await this.fetcher(`${GITHUB_API}${path}`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }

  /** A repo file's bytes, through the API so private repos work. */
  async file(fullName: string, path: string, ref: string, maxBytes: number): Promise<Uint8Array | null> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    try {
      const response = await this.fetcher(
        `${GITHUB_API}/repos/${fullName}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
        { headers: this.headers("application/vnd.github.raw"), signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      return bytes.byteLength <= maxBytes ? bytes : null;
    } catch {
      return null;
    }
  }

  async readme(fullName: string): Promise<{ text: string; path: string } | null> {
    const meta = await this.json<{ path?: string; content?: string; encoding?: string }>(
      `/repos/${fullName}/readme`,
    );
    if (!meta?.content || meta.encoding !== "base64") return null;
    try {
      const binary = atob(meta.content.replace(/\s+/g, ""));
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      return { text: new TextDecoder().decode(bytes), path: meta.path ?? "README.md" };
    } catch {
      return null;
    }
  }
}

interface RepoResponse {
  full_name: string;
  html_url: string;
  private: boolean;
  default_branch: string;
  homepage: string | null;
  owner: { login: string; html_url: string; type: string };
}

interface OwnerResponse {
  blog?: string | null;
  twitter_username?: string | null;
}

interface TreeResponse {
  tree?: { path: string; type: string }[];
}

export async function readRepositorySignals(
  reader: GitHubReader,
  fullName: string,
): Promise<RepositorySignals | null> {
  const repo = await reader.json<RepoResponse>(`/repos/${fullName}`);
  if (!repo) return null;
  const isOrganization = repo.owner.type === "Organization";
  const [owner, readme, tree] = await Promise.all([
    reader.json<OwnerResponse>(
      `${isOrganization ? "/orgs" : "/users"}/${encodeURIComponent(repo.owner.login)}`,
    ),
    reader.readme(repo.full_name),
    reader.json<TreeResponse>(
      `/repos/${repo.full_name}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`,
    ),
  ]);
  const candidates: LogoCandidate[] = [];
  const fromReadme = readme ? readmeLogo(readme.text, readme.path, repo.full_name) : [];
  candidates.push(...fromReadme.filter((c) => c.source === "readme_picture"));
  const fromTree = treeLogo(tree);
  if (fromTree) candidates.push(fromTree);
  candidates.push(...fromReadme.filter((c) => c.source !== "readme_picture"));
  return {
    fullName: repo.full_name,
    htmlUrl: repo.html_url,
    isPrivate: repo.private,
    defaultBranch: repo.default_branch,
    homepage: repo.homepage?.trim() || null,
    owner: {
      login: repo.owner.login,
      htmlUrl: repo.owner.html_url,
      isOrganization,
      blog: owner?.blog?.trim() || null,
      twitter: owner?.twitter_username?.trim() || null,
    },
    readme: readme?.text ?? null,
    readmePath: readme?.path ?? "README.md",
    logoCandidates: candidates,
  };
}

/** Badges, CI status, sponsors and stats are never a logo. */
const NOT_A_LOGO = /shields\.io|badge|badgen|\/actions\/workflows|codecov|coveralls|npmjs\.com|travis-ci|circleci|deepwiki|gitpod|contrib\.rocks|star-history|vercel\.com\/button|opencollective|sponsor|backers|stats|screenshot|demo|preview|\.gif(?:$|\?)/i;

/**
 * Turns a README image reference into a location. Paths in the same repo
 * go through the API; other hosts go through the public fetcher.
 */
export function resolveReadmeImage(
  raw: string | undefined,
  readmePath: string,
  fullName: string,
): ImageLocation | null {
  if (!raw) return null;
  const value = raw.trim().replace(/^<|>$/g, "").split(/\s+/)[0];
  if (!value || value.startsWith("data:") || value.startsWith("#")) return null;
  const [owner, name] = fullName.toLowerCase().split("/");
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const segments = url.pathname.split("/").filter(Boolean);
      const sameRepo = segments[0]?.toLowerCase() === owner && segments[1]?.toLowerCase() === name;
      if (url.hostname === "raw.githubusercontent.com" && sameRepo && segments.length > 3) {
        return { kind: "repo", path: decodeURIComponent(segments.slice(3).join("/")) };
      }
      if (url.hostname === "github.com" && sameRepo && (segments[2] === "blob" || segments[2] === "raw") && segments.length > 4) {
        return { kind: "repo", path: decodeURIComponent(segments.slice(4).join("/")) };
      }
      if (url.hostname === "github.com" && (segments[2] === "blob" || segments[2] === "raw")) {
        return { kind: "url", url: `https://raw.githubusercontent.com/${segments[0]}/${segments[1]}/${segments.slice(3).join("/")}` };
      }
      return { kind: "url", url: url.href };
    } catch {
      return null;
    }
  }
  const base = readmePath.includes("/") ? readmePath.slice(0, readmePath.lastIndexOf("/") + 1) : "";
  const joined = value.startsWith("/") ? value.slice(1) : `${base}${value}`;
  const parts: string[] = [];
  for (const part of joined.split(/[?#]/)[0].split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.length ? { kind: "repo", path: decodeURIComponent(parts.join("/")) } : null;
}

function readmeLogo(readme: string, readmePath: string, fullName: string): LogoCandidate[] {
  const head = readme.split("\n").slice(0, 80).join("\n");
  const out: LogoCandidate[] = [];
  const picture = head.match(/<picture\b[\s\S]*?<\/picture>/i)?.[0];
  if (picture) {
    const sources = [...picture.matchAll(/<source\b[^>]*>/gi)].map((m) => parseAttributes(m[0]));
    const image = picture.match(/<img\b[^>]*>/i)?.[0];
    const darkSource = sources.find((s) => /dark/i.test(s.media ?? ""));
    const lightSource = sources.find((s) => /light/i.test(s.media ?? ""));
    const lightRaw = lightSource?.srcset ?? (image ? parseAttributes(image).src : undefined);
    const light = resolveReadmeImage(lightRaw, readmePath, fullName);
    if (light && !NOT_A_LOGO.test(lightRaw ?? "")) {
      out.push({
        source: "readme_picture",
        light,
        dark: resolveReadmeImage(darkSource?.srcset, readmePath, fullName),
      });
    }
  }
  const images: { url?: string; alt: string }[] = [];
  for (const match of head.matchAll(/<img\b[^>]*>/gi)) {
    const attributes = parseAttributes(match[0]);
    images.push({ url: attributes.src, alt: attributes.alt ?? "" });
  }
  for (const match of head.matchAll(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g)) {
    images.push({ url: match[2], alt: match[1] });
  }
  const named = images.find(
    (image) => image.url && /logo|wordmark|banner|header/i.test(`${image.url} ${image.alt}`) && !NOT_A_LOGO.test(`${image.url} ${image.alt}`),
  );
  const location = resolveReadmeImage(named?.url, readmePath, fullName);
  if (location && !out.some((c) => sameLocation(c.light, location))) {
    out.push({ source: "readme_image", light: location, dark: null });
  }
  return out;
}

function sameLocation(a: ImageLocation, b: ImageLocation): boolean {
  if (a.kind === "repo" && b.kind === "repo") return a.path === b.path;
  if (a.kind === "url" && b.kind === "url") return a.url === b.url;
  return false;
}

const LOGO_FILE = /(?:^|\/)(?:logo|logomark|wordmark|logotype)[-_.\w]*\.(?:svg|png)$/i;
const NOT_A_PROJECT_LOGO_PATH = /node_modules|test|fixture|example|vendor|third[-_]party|\/icons?\/|\/integrations?\//i;
const DARK_FILE = /(?:^|[-_./])(?:dark|white|inverse|inverted|light[-_]?text)(?:[-_.]|$)/i;

function treeLogo(tree: TreeResponse | null): LogoCandidate | null {
  const hits = (tree?.tree ?? [])
    .filter((entry) => entry.type === "blob" && LOGO_FILE.test(entry.path) && !NOT_A_PROJECT_LOGO_PATH.test(entry.path))
    .map((entry) => ({
      path: entry.path,
      depth: entry.path.split("/").length,
      svg: entry.path.toLowerCase().endsWith(".svg"),
      dark: DARK_FILE.test(entry.path),
    }))
    .sort((a, b) => a.depth - b.depth || Number(b.svg) - Number(a.svg) || a.path.localeCompare(b.path));
  const light = hits.find((hit) => !hit.dark);
  if (!light) return null;
  const dark = hits.find((hit) => hit.dark && hit.path.split("/").slice(0, -1).join("/") === light.path.split("/").slice(0, -1).join("/"));
  return {
    source: "repo_file",
    light: { kind: "repo", path: light.path },
    dark: dark ? { kind: "repo", path: dark.path } : null,
  };
}
