import type { Fetcher } from "./fetch";
import type { LogoCandidate } from "./types";

const CONTEXT_DEV_BRAND_URL = "https://api.context.dev/v1/brand/retrieve";

interface ContextDevLogo {
  url?: string;
  mode?: "light" | "dark" | "has_opaque_background";
  type?: "icon" | "logo";
  colors?: { hex?: string }[];
}

interface ContextDevResponse {
  brand?: {
    logos?: ContextDevLogo[];
    socials?: { type?: string; url?: string }[];
  };
}

export interface ContextDevBrand {
  logo: LogoCandidate | null;
  /** The colors of the chosen light logo, most used first. */
  logoColors: string[];
  socials: string[];
}

/**
 * One Brand API lookup by domain (10 credits). Only the logos, the colors of
 * the chosen logo, and the social links are used: the bake-off showed that
 * its site colors are often UI accents, not the brand color.
 */
export async function lookupContextDevBrand(
  fetcher: Fetcher,
  apiKey: string,
  domain: string,
): Promise<ContextDevBrand | null> {
  let body: ContextDevResponse;
  try {
    const response = await fetcher(CONTEXT_DEV_BRAND_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "by_domain",
        domain,
        timeoutOpts: { milliseconds: 20_000, behavior: "return-partial" },
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    body = (await response.json()) as ContextDevResponse;
  } catch {
    return null;
  }
  const logos = (body.brand?.logos ?? []).filter((logo) => typeof logo.url === "string");
  const wordmarks = logos.filter((logo) => logo.type === "logo");
  const icons = logos.filter((logo) => logo.type === "icon");
  const light =
    wordmarks.find((logo) => logo.mode === "light") ??
    wordmarks.find((logo) => logo.mode === "has_opaque_background") ??
    icons.find((logo) => logo.mode === "light") ??
    icons.find((logo) => logo.mode === "has_opaque_background");
  const dark =
    (light?.type === "icon" ? icons : wordmarks).find((logo) => logo.mode === "dark") ?? null;
  return {
    logo: light?.url
      ? {
          source: "context_dev",
          light: { kind: "url", url: light.url },
          dark: dark?.url ? { kind: "url", url: dark.url } : null,
        }
      : null,
    logoColors: (light?.colors ?? [])
      .map((color) => color.hex)
      .filter((hex): hex is string => typeof hex === "string"),
    socials: (body.brand?.socials ?? [])
      .map((social) => social.url)
      .filter((url): url is string => typeof url === "string"),
  };
}
