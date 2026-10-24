import { ConfigLink } from "@/src/site-config/config-link";
import { useSiteConfig } from "@/src/site-config/site-config-context";
import { FaGithub } from "react-icons/fa6";

import { Logo } from "@/src/components/navigation/logo";

const openSourceRepoUrl = import.meta.env.VITE_OPENSOURCE_REPO_URL;

export function Footer() {
  const config = useSiteConfig();
  return (
    <footer className="flex min-h-32 w-full flex-wrap items-center justify-center gap-4 border-t px-2 py-3 text-sm text-foreground sm:justify-between sm:gap-0 sm:px-4 sm:py-0 lg:px-8">
      {config.footer.groups.length > 0 && (
        <div className="grid w-full gap-8 py-8 sm:grid-cols-3">
          {config.footer.groups.map((group, index) => (
            <section key={index}>
              <h2 className="mb-3 font-semibold">{group.title}</h2>
              <ul className="space-y-2">
                {group.links.map((link, linkIndex) => (
                  <li key={linkIndex}>
                    <ConfigLink href={link.href} newTab={link.newTab}>
                      {link.label}
                    </ConfigLink>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {Object.entries(config.footer.socials).some(([, href]) => href) && (
        <div className="flex gap-4">
          {Object.entries(config.footer.socials).map(([name, href]) =>
            href ? (
              <ConfigLink key={name} href={href}>
                {name}
              </ConfigLink>
            ) : null
          )}
        </div>
      )}
      <p className="items-center">
        &copy; {new Date().getFullYear()}{" "}
        <ConfigLink
          title={config.name}
          aria-label={config.name}
          className="font-semibold"
          href={config.branding.logo.href}
        >
          {config.name}
        </ConfigLink>
        .
      </p>
      {openSourceRepoUrl && (
        <a
          href={openSourceRepoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Free and Open Source on GitHub"
        >
          Free and OpenSource
          <FaGithub className="h-4 w-4" aria-hidden="true" />
        </a>
      )}
      {config.branding.poweredBy && (
        <div className="hidden items-center md:block">
          <Logo variant="full" size={16} doxa />
        </div>
      )}
    </footer>
  );
}
