import type { ComponentType, ReactNode } from "react";

export interface ProseLinkProps {
  href?: string;
  className?: string;
  children?: ReactNode;
}

export type ProseLinkComponent = ComponentType<ProseLinkProps>;

/**
 * Default link for prose.
 *
 * A plain anchor works anywhere. The docs renderer injects its router-aware
 * link so internal navigation stays client side. The dashboard preview keeps
 * this one: a preview must not navigate the editor away.
 */
export function ProseLink({ href = "#", className, children }: ProseLinkProps) {
  const isExternal = /^https?:\/\//i.test(href);

  return (
    <a
      href={href}
      className={className}
      {...(isExternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {children}
    </a>
  );
}
