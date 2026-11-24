import type { ComponentType, ReactNode } from "react";

import { cn } from "../lib/cn";
import { ProseLink, type ProseLinkComponent } from "./link";

export type CardVariant = "normal" | "small" | "image";

export type IconComponent = ComponentType<{ className?: string }>;

/** Resolves an icon name from MDX to a component. */
export type IconResolver = (name: string) => IconComponent | null;

export interface CardProps {
  subtitle?: string;
  title: string;
  description?: string;
  href?: string;
  image?: string;
  className?: string;
  external?: boolean;
  icon?: string;
  variant?: CardVariant;
  children?: ReactNode;
}

export interface CardDependencies {
  link: ProseLinkComponent;
  resolveIcon: IconResolver;
  /** Drawn in the corner of an external card. */
  ExternalIcon?: IconComponent;
}

/**
 * Builds the `Card` component around the host application's link and icons.
 *
 * The card is the one prose component that needs both, and neither can live in
 * a shared package: the docs renderer routes links through its router and reads
 * icons from its own registry.
 */
export function createCard({ link: Link, resolveIcon, ExternalIcon }: CardDependencies) {
  return function Card({
    subtitle,
    title,
    description,
    href,
    image,
    className,
    external = false,
    icon,
    variant = "normal",
    children,
  }: CardProps) {
    const IconComponent = icon ? resolveIcon(icon) : null;

    const content = (
      <div
        className={cn(
          "relative flex overflow-hidden rounded-lg border border-border bg-card shadow-md",
          // A linked card shows it is clickable by a slight tint of the
          // theme's muted color, with no motion.
          href && "hover:bg-muted/50",
          variant === "small"
            ? "items-center space-x-2 p-3"
            : variant === "image"
              ? "h-full flex-col justify-between p-0"
              : "h-full flex-col justify-between p-3 sm:p-4",
          className,
        )}
      >
        {external && href && variant !== "image" && ExternalIcon && (
          <div
            className={cn(
              "absolute top-2 text-muted-foreground",
              variant === "small" ? "right-0" : "right-2",
            )}
          >
            <ExternalIcon className="h-4 w-4" />
          </div>
        )}
        <div>
          {subtitle && variant === "normal" && (
            <p className="my-1! text-xs font-semibold text-muted-foreground">
              {subtitle}
            </p>
          )}
          {image && variant === "image" && (
            <img
              src={image}
              alt={title}
              width={400}
              height={400}
              loading="lazy"
              className="m-0! h-[180px] w-full rounded-none! border-0 object-cover object-center"
            />
          )}
          {/* The icon sits beside the title, centered on its first line, so a
              title that wraps keeps the icon at the top. The top margin puts
              it on that line, 1px under center for normal cards so it meets
              the letters' cap height, and centered for small ones. */}
          <div
            className={cn(
              "flex items-start gap-2.5",
              variant === "image" && "p-4",
            )}
          >
            {IconComponent && (
              <IconComponent
                className={cn(
                  "shrink-0 text-muted-foreground",
                  variant === "normal" ? "mt-1 size-5.5" : "mt-0.5 size-4",
                )}
              />
            )}
            <div
              className={cn(
                "min-w-0 font-semibold",
                variant === "normal"
                  ? "text-lg leading-7"
                  : "text-sm leading-5",
                className,
              )}
            >
              {title}
            </div>
          </div>
          {description && variant === "normal" && (
            <p className="my-2! text-sm font-normal text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {children}
      </div>
    );

    if (!href) return content;

    return (
      <Link href={href} className="no-underline!">
        {content}
      </Link>
    );
  };
}

/** Card without host links or icons, used where neither is available. */
export const Card = createCard({ link: ProseLink, resolveIcon: () => null });

export function CardGrid({ children }: { children?: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:gap-6 md:grid-cols-2 2xl:grid-cols-3">
      {children}
    </div>
  );
}
