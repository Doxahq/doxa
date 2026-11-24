import type { ElementType } from "react";
import { assetUrl } from "@/src/site-config/asset-url";
import { ConfigLink } from "@/src/site-config/config-link";
import { useSiteConfig } from "@/src/site-config/site-config-context";

type LogoVariant = "full" | "icon";

interface LogoProps {
  doxa?: boolean;
  variant?: LogoVariant;
  size?: number;
  className?: string;
  as?: ElementType;
}

const LOGO_ASPECT = 193 / 160;

/** The font of the site name next to the logo, and of the Doxa wordmark. */
export const WORDMARK_FONT_STYLE = {
  fontFamily: "'Sora', sans-serif",
} as const;

export function LogoMark({
  size = 28,
  doxa = false,
}: {
  size?: number;
  doxa?: boolean;
}) {
  const { branding } = useSiteConfig();
  const light = doxa ? null : (branding.logo.light ?? branding.logo.dark);
  const dark = doxa ? null : (branding.logo.dark ?? branding.logo.light);
  const height = size * LOGO_ASPECT;
  return (
    <span
      className="inline-block shrink-0"
      style={{ width: size, height }}
      aria-hidden="true"
    >
      <img
        src={light ? assetUrl(light) : "/doxa-logo-new-dark.svg"}
        alt=""
        width={size}
        height={height}
        className="block size-full dark:hidden"
        draggable={false}
      />
      <img
        src={dark ? assetUrl(dark) : "/doxa-logo-new-light.svg"}
        alt=""
        width={size}
        height={height}
        className="hidden size-full dark:block"
        draggable={false}
      />
    </span>
  );
}

export function Logo({
  variant = "full",
  size = 16,
  className,
  as: Tag = "span",
  doxa = false,
}: LogoProps) {
  const config = useSiteConfig();
  const name = doxa ? "doxa" : config.name;
  if (variant === "icon") {
    return <LogoMark size={size} doxa={doxa} />;
  }

  return (
    <ConfigLink
      href={doxa ? "https://doxa.so" : config.branding.logo.href}
      title={`${name} home`}
      aria-label={`${name} home`}
      className={`flex items-center gap-1.5 ${className ?? ""}`}
    >
      <LogoMark size={size} doxa={doxa} />
      <Tag
        className="text-[1em] font-semibold text-foreground"
        style={WORDMARK_FONT_STYLE}
      >
        {name}
      </Tag>
    </ConfigLink>
  );
}
