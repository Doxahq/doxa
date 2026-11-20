import {
  createDefaultSiteConfig,
  footerSchema,
  resolveSiteConfig,
  siteConfigSchema,
  socialHrefSchema,
  type ResolvedSiteConfig,
  type SiteConfigInput,
} from "@doxahq/site-config";
import { contrastRatio, parseColor, type Rgb } from "./color";
import type { DiscoveredBranding } from "./discover";
import { SOCIAL_KINDS } from "./types";

export type BrandingField =
  | "logo"
  | "logo_dark"
  | "favicon"
  | "primary_color"
  | "github"
  | "socials"
  | "footer";

export interface AppliedBranding {
  config: SiteConfigInput;
  applied: BrandingField[];
}

/** Below this contrast against the page background, the preset color stays. */
const MIN_PRIMARY_CONTRAST = 3;
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

/**
 * Fills the branding fields that still hold their defaults. A field that a
 * person set is never changed.
 */
export function applyDiscoveredBranding(
  base: SiteConfigInput | undefined,
  projectName: string,
  found: DiscoveredBranding,
): AppliedBranding {
  const input: SiteConfigInput = structuredClone(base ?? createDefaultSiteConfig({ projectName }));
  const current = resolveSiteConfig(input);
  const applied: BrandingField[] = [];
  let next: SiteConfigInput = input;

  if (found.logo && current.branding.logo.light === null && current.branding.logo.dark === null) {
    next = {
      ...next,
      branding: {
        ...next.branding,
        logo: { ...next.branding?.logo, light: found.logo.light, dark: found.logo.dark },
      },
    };
    applied.push("logo");
    if (found.logo.dark) applied.push("logo_dark");
  }

  if (found.favicon && current.branding.favicon === null) {
    next = { ...next, branding: { ...next.branding, favicon: found.favicon } };
    applied.push("favicon");
  }

  const primary = found.primaryColor ? primaryTokens(current, found.primaryColor.hex) : null;
  if (primary) {
    const tokens = next.theme?.tokens;
    next = {
      ...next,
      theme: {
        ...next.theme,
        tokens: {
          light: { ...tokens?.light, ...primary.light },
          dark: { ...tokens?.dark, ...primary.dark },
        },
      },
    };
    applied.push("primary_color");
  }

  if (!found.repositoryIsPrivate && current.navbar.github === null) {
    next = { ...next, navbar: { ...next.navbar, github: found.repositoryUrl } };
    applied.push("github");
  }

  const socials: Record<string, string> = {};
  for (const kind of SOCIAL_KINDS) {
    const url = found.socials[kind];
    if (url && current.footer.socials[kind] === null && socialHrefSchema.safeParse(url).success) {
      socials[kind] = url;
    }
  }
  if (Object.keys(socials).length > 0) {
    next = {
      ...next,
      footer: { ...next.footer, socials: { ...next.footer?.socials, ...socials } },
    };
    applied.push("socials");
  }

  if (current.footer.groups.length === 0 && found.footerGroups.length > 0) {
    const groups = found.footerGroups.map((group) => ({
      title: group.title,
      links: group.links.map((link) => ({ label: link.label, href: link.href, newTab: false })),
    }));
    if (footerSchema.safeParse({ groups }).success) {
      next = { ...next, footer: { ...next.footer, groups } };
      applied.push("footer");
    }
  }

  if (applied.length === 0 || !siteConfigSchema.safeParse(next).success) {
    return { config: input, applied: [] };
  }
  return { config: next, applied };
}

type PrimaryTokens = { light: Record<string, string>; dark: Record<string, string> };

/**
 * The brand color for each mode where it reads on the page background, with
 * black or white text on it. Null when the theme already has its own primary
 * color, or when the color reads in no mode.
 */
function primaryTokens(current: ResolvedSiteConfig, hex: string): PrimaryTokens | null {
  const brand = parseColor(hex);
  if (!brand || current.theme.primary !== null) return null;
  const pristine = resolveSiteConfig({
    name: current.name,
    theme: { preset: current.theme.preset },
  }).theme.tokens;
  if (
    current.theme.tokens.light.primary !== pristine.light.primary ||
    current.theme.tokens.dark.primary !== pristine.dark.primary
  ) {
    return null;
  }
  const foreground = contrastRatio(brand, WHITE) >= contrastRatio(brand, BLACK) ? "#FFFFFF" : "#000000";
  const out: PrimaryTokens = { light: {}, dark: {} };
  const modes = current.theme.colorMode === "dark-only" ? (["dark"] as const) : (["light", "dark"] as const);
  for (const mode of modes) {
    const background = parseColor(current.theme.tokens[mode].background);
    if (!background || contrastRatio(brand, background) < MIN_PRIMARY_CONTRAST) continue;
    out[mode] = { primary: hex, primaryForeground: foreground };
  }
  return Object.keys(out.light).length + Object.keys(out.dark).length > 0 ? out : null;
}
