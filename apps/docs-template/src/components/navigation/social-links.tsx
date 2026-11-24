import { ConfigLink } from "@/src/site-config/config-link";
import type { ClientSiteConfig } from "@doxahq/site-config";
import type { IconType } from "react-icons";
import {
  FaDiscord,
  FaGithub,
  FaLinkedin,
  FaXTwitter,
  FaYoutube,
} from "react-icons/fa6";

import { cn } from "@/src/lib/utils";

export type SiteSocials = ClientSiteConfig["footer"]["socials"];

interface SocialPlatform {
  key: keyof SiteSocials;
  label: string;
  Icon: IconType;
}

/** One entry for each social link in the site config, in display order. */
export const SOCIAL_PLATFORMS = [
  { key: "github", label: "GitHub", Icon: FaGithub },
  { key: "x", label: "X", Icon: FaXTwitter },
  { key: "linkedin", label: "LinkedIn", Icon: FaLinkedin },
  { key: "discord", label: "Discord", Icon: FaDiscord },
  { key: "youtube", label: "YouTube", Icon: FaYoutube },
] as const satisfies readonly SocialPlatform[];

/** Icon links to the socials that the site sets. Nothing when it sets none. */
export function SocialLinks({
  socials,
  className,
}: {
  socials: SiteSocials;
  className?: string;
}) {
  const links = SOCIAL_PLATFORMS.flatMap((platform) => {
    const href = socials[platform.key];
    return href ? [{ ...platform, href }] : [];
  });
  if (links.length === 0) return null;

  return (
    <ul className={cn("flex items-center gap-0.5", className)}>
      {links.map(({ key, label, Icon, href }) => (
        <li key={key}>
          <ConfigLink
            href={href}
            title={label}
            aria-label={label}
            className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <Icon className="size-4" aria-hidden="true" />
          </ConfigLink>
        </li>
      ))}
    </ul>
  );
}
