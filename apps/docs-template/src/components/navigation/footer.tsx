import { useEffect, useState } from "react";
import { ConfigLink } from "@/src/site-config/config-link";
import { useSiteConfig } from "@/src/site-config/site-config-context";
import type { ClientSiteConfig } from "@doxahq/site-config";
import { FaGithub } from "react-icons/fa6";

import { Logo } from "@/src/components/navigation/logo";
import { PoweredByDoxa } from "@/src/components/navigation/powered-by-doxa";
import { SocialLinks } from "@/src/components/navigation/social-links";

type FooterGroup = ClientSiteConfig["footer"]["groups"][number];

const openSourceRepoUrl = import.meta.env.VITE_OPENSOURCE_REPO_URL;

/**
 * The end of a docs page, in the article column under the page links: the
 * "Powered by Doxa" credit, then the site's brand, socials, link groups and
 * copyright. All of it comes from the site config.
 */
export function Footer() {
  const { branding, footer } = useSiteConfig();
  return (
    <footer className="not-prose">
      {branding.poweredBy && (
        <div className="mt-13 -mb-7 flex justify-center">
          <PoweredByDoxa />
        </div>
      )}
      <div className="mt-18 flex flex-col gap-7 border-t pt-7 pb-12">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <Logo size={18} className="text-[15px]" />
          <SocialLinks socials={footer.socials} className="-mr-2" />
        </div>
        {footer.groups.length > 0 && (
          <FooterLinkGroups groups={footer.groups} />
        )}
        <FooterLegal />
      </div>
    </footer>
  );
}

function FooterLinkGroups({ groups }: { groups: readonly FooterGroup[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(9.5rem,100%),1fr))] gap-x-8 gap-y-6">
      {groups.map((group, index) => (
        <nav key={index} aria-label={group.title}>
          <h2 className="text-[13px] font-semibold text-foreground">
            {group.title}
          </h2>
          <ul className="mt-2.5 flex flex-col gap-2.5">
            {group.links.map((link, linkIndex) => (
              <li key={linkIndex}>
                <ConfigLink
                  href={link.href}
                  newTab={link.newTab}
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  {link.label}
                </ConfigLink>
              </li>
            ))}
          </ul>
        </nav>
      ))}
    </div>
  );
}

function FooterLegal() {
  const { name } = useSiteConfig();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-[13px] text-muted-foreground">
      <p>
        &copy; <CopyrightYear />
        {name}
      </p>
      {openSourceRepoUrl && (
        <a
          href={openSourceRepoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 font-medium transition-colors hover:text-foreground"
          aria-label="Free and Open Source on GitHub"
        >
          Free and OpenSource
          <FaGithub className="size-4" aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

/**
 * Production HTML stays in the cache for up to a year, so the server never
 * renders the year. The browser adds it after hydration.
 */
function CopyrightYear() {
  const [year, setYear] = useState<number | null>(null);
  useEffect(() => setYear(new Date().getFullYear()), []);
  return year === null ? null : <>{year} </>;
}
