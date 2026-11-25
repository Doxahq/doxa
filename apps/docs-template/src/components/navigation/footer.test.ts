import { createElement, type ComponentProps } from "react";
import {
  resolveSiteConfig,
  toClientSiteConfig,
  type SiteConfigInput,
} from "@doxahq/site-config";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SiteConfigProvider } from "../../site-config/site-config-context";
import { Footer } from "./footer";
import { SOCIAL_PLATFORMS } from "./social-links";

vi.mock("../../lib/transition", () => ({
  Link: (props: ComponentProps<"a">) => createElement("a", props),
}));

function renderFooter(input: SiteConfigInput = {}) {
  return renderToStaticMarkup(
    createElement(SiteConfigProvider, {
      config: toClientSiteConfig(resolveSiteConfig(input)),
      children: createElement(Footer),
    })
  );
}

const ALL_SOCIALS = {
  github: "https://github.com/acme",
  x: "https://x.com/acme",
  linkedin: "https://www.linkedin.com/company/acme",
  discord: "https://discord.gg/acme",
  youtube: "https://www.youtube.com/@acme",
};

describe("docs footer", () => {
  it("leaves the Powered by Doxa credit to the page links above it", () => {
    expect(renderFooter()).not.toContain("Powered by");
  });

  it("renders the site name, its link groups and an icon for each social", () => {
    const html = renderFooter({
      name: "Acme Docs",
      footer: {
        groups: [
          {
            title: "Product",
            links: [{ label: "Pricing", href: "https://acme.dev/pricing" }],
          },
        ],
        socials: ALL_SOCIALS,
      },
    });

    expect(html).toContain("Acme Docs");
    expect(html).toContain('aria-label="Product"');
    expect(html).toContain('href="https://acme.dev/pricing"');
    for (const { key, label } of SOCIAL_PLATFORMS) {
      expect(html).toContain(`href="${ALL_SOCIALS[key]}"`);
      expect(html).toContain(`aria-label="${label}"`);
    }
  });

  it("renders no social list and no link groups for a new site", () => {
    const html = renderFooter();

    expect(html).not.toContain("<nav");
    expect(html).not.toContain("<ul");
  });

  it("has a social platform for every social in the site config", () => {
    const configKeys = Object.keys(resolveSiteConfig({}).footer.socials);

    expect(SOCIAL_PLATFORMS.map(({ key }) => key).sort()).toEqual(
      configKeys.sort()
    );
  });
});
