import { isNeutral, parseColor, toHex } from "./color";
import { lookupContextDevBrand } from "./context-dev";
import { fetchPublic, type Fetcher } from "./fetch";
import { GitHubReader, readRepositorySignals, type RepositorySignals } from "./github";
import { brandHomepageUrl, readHomepageSignals } from "./homepage";
import { inspectImage, type InspectedImage } from "./image";
import { collectSocials } from "./socials";
import type {
  FooterGroup,
  ImageLocation,
  LogoCandidate,
  LogoSource,
  SocialLinks,
} from "./types";

/** The plan limits of `@doxahq/site-config` asset uploads. */
const MAX_LOGO_BYTES = 512 * 1024;
const MAX_FAVICON_BYTES = 128 * 1024;
const MAX_LOGO_TRIES = 6;

export type ContextDevUse = "disabled" | "not_needed" | "used" | "no_result";

export interface DiscoveredBranding {
  homepage: string | null;
  repositoryUrl: string;
  repositoryIsPrivate: boolean;
  logo: { light: string; dark: string | null; source: LogoSource } | null;
  favicon: string | null;
  primaryColor: { hex: string; source: "logo" | "context_dev_logo" } | null;
  socials: SocialLinks;
  footerGroups: FooterGroup[];
  contextDev: ContextDevUse;
}

export interface DiscoverBrandingInput {
  repositoryFullName: string;
  fetch: Fetcher;
  githubToken: string;
  /** Null unless Context.dev is turned on and has a key. */
  contextDevApiKey: string | null;
  /** Stores an image as a site asset and returns its `asset:` ref. */
  storeAsset(kind: "logo" | "favicon", bytes: Uint8Array): Promise<string>;
}

interface LoadedImage {
  bytes: Uint8Array;
  info: InspectedImage;
}

/**
 * Finds the brand of a repository: GitHub first (repo, owner, README, logo
 * files), then the homepage named by the repo or its organization. Context.dev
 * runs only when it is configured and the free pass found no logo or no color.
 */
export async function discoverBranding(
  input: DiscoverBrandingInput,
): Promise<DiscoveredBranding | null> {
  const github = new GitHubReader(input.fetch, input.githubToken);
  const repo = await readRepositorySignals(github, input.repositoryFullName);
  if (!repo) return null;
  const homepageUrl = brandHomepageUrl(repo.homepage) ??
    (repo.owner.isOrganization ? brandHomepageUrl(repo.owner.blog) : null);
  const homepage = homepageUrl ? await readHomepageSignals(input.fetch, homepageUrl) : null;

  const load = (location: ImageLocation, purpose: "logo" | "favicon") =>
    loadImage(github, repo, input.fetch, location, purpose);

  // README <picture> first, then the homepage header, then repo files, JSON-LD, README images.
  const [picture, ...repoRest] = repo.logoCandidates[0]?.source === "readme_picture"
    ? repo.logoCandidates
    : [null, ...repo.logoCandidates];
  const homeHeader = homepage?.logoCandidates.filter((c) => c.source === "homepage_header") ?? [];
  const homeLd = homepage?.logoCandidates.filter((c) => c.source === "json_ld") ?? [];
  const ordered = [
    ...(picture ? [picture] : []),
    ...homeHeader,
    ...repoRest.filter((c): c is LogoCandidate => c?.source === "repo_file"),
    ...homeLd,
    ...repoRest.filter((c): c is LogoCandidate => c?.source === "readme_image"),
  ];

  let chosen = await chooseLogo(ordered.slice(0, MAX_LOGO_TRIES), load);
  let color = chosen ? logoColor(chosen) : null;
  let contextDev: ContextDevUse = input.contextDevApiKey ? "not_needed" : "disabled";
  const socials: SocialLinks = {};
  const contextSocials: string[] = [];

  const domain = homepage ? new URL(homepage.url).hostname : null;
  // A raster logo hides its colors from this step; a neutral SVG logo means a black-and-white brand.
  const colorUnknown = chosen !== null && !color && chosen.light.info.format !== "svg";
  if (input.contextDevApiKey && domain && (!chosen || colorUnknown)) {
    const brand = await lookupContextDevBrand(input.fetch, input.contextDevApiKey, domain);
    contextDev = brand ? "used" : "no_result";
    if (brand) {
      contextSocials.push(...brand.socials);
      const fromContext = !chosen && brand.logo ? await chooseLogo([brand.logo], load) : null;
      if (fromContext) {
        chosen = fromContext;
        color = logoColor(fromContext);
      }
      if (!color) {
        const hex = brand.logoColors
          .map((value) => parseColor(value))
          .find((rgb) => rgb !== null && !isNeutral(rgb));
        if (hex && (fromContext || colorUnknown)) {
          color = { hex: toHex(hex), source: "context_dev_logo" };
        }
      }
    }
  }

  // Earlier sources win: the owner's own X account, then the homepage, then Context.dev, then the README.
  collectSocials(socials, [repo.owner.htmlUrl]);
  if (repo.owner.twitter) collectSocials(socials, [`https://x.com/${repo.owner.twitter}`]);
  collectSocials(socials, homepage?.links ?? []);
  collectSocials(socials, contextSocials);
  if (repo.readme) collectSocials(socials, repo.readme.match(/https?:\/\/[^\s)"'<>\]]+/g) ?? []);

  const logo = chosen
    ? {
        light: await input.storeAsset("logo", chosen.light.bytes),
        dark: chosen.dark ? await input.storeAsset("logo", chosen.dark.bytes) : null,
        source: chosen.source,
      }
    : null;

  let favicon: string | null = null;
  for (const href of homepage?.favicons ?? []) {
    const image = await load({ kind: "url", url: href }, "favicon");
    if (!image) continue;
    favicon = await input.storeAsset("favicon", image.bytes);
    break;
  }

  return {
    homepage: homepage?.url ?? null,
    repositoryUrl: repo.htmlUrl,
    repositoryIsPrivate: repo.isPrivate,
    logo,
    favicon,
    primaryColor: color,
    socials,
    footerGroups: homepage?.footerGroups ?? [],
    contextDev,
  };
}

interface ChosenLogo {
  source: LogoSource;
  light: LoadedImage;
  dark: LoadedImage | null;
}

/**
 * The first candidate that loads and looks like a logo. A logo whose paint is
 * all light is drawn for dark backgrounds: it becomes the dark variant, and
 * the search goes on for a light one.
 */
async function chooseLogo(
  candidates: LogoCandidate[],
  load: (location: ImageLocation, purpose: "logo") => Promise<LoadedImage | null>,
): Promise<ChosenLogo | null> {
  let darkOnly: LoadedImage | null = null;
  for (const candidate of candidates) {
    const light = await load(candidate.light, "logo");
    if (!light) continue;
    if (light.info.lightOnly) {
      darkOnly ??= light;
      continue;
    }
    const dark = candidate.dark ? await load(candidate.dark, "logo") : null;
    return { source: candidate.source, light, dark: dark ?? darkOnly };
  }
  return null;
}

function logoColor(logo: ChosenLogo): DiscoveredBranding["primaryColor"] {
  const hex = logo.light.info.dominantColor ?? logo.dark?.info.dominantColor ?? null;
  if (!hex) return null;
  return { hex, source: logo.source === "context_dev" ? "context_dev_logo" : "logo" };
}

async function loadImage(
  github: GitHubReader,
  repo: RepositorySignals,
  fetcher: Fetcher,
  location: ImageLocation,
  purpose: "logo" | "favicon",
): Promise<LoadedImage | null> {
  const maxBytes = purpose === "logo" ? MAX_LOGO_BYTES : MAX_FAVICON_BYTES;
  let bytes: Uint8Array | null = null;
  if (location.kind === "inline") {
    bytes = new TextEncoder().encode(location.svg);
    if (bytes.byteLength > maxBytes) return null;
  } else if (location.kind === "repo") {
    bytes = await github.file(repo.fullName, location.path, repo.defaultBranch, maxBytes);
  } else {
    bytes = (await fetchPublic(fetcher, location.url, { maxBytes, timeoutMs: 10_000, accept: "image/*" }))?.bytes ?? null;
  }
  if (!bytes) return null;
  const info = inspectImage(bytes, purpose);
  return "rejected" in info ? null : { bytes, info };
}
