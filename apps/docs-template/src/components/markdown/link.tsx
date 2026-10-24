import type { ProseLinkProps } from "@doxahq/docs-prose";

import { Link } from "@/src/lib/transition";

/**
 * Prose link for the published docs.
 *
 * Injected into `@doxahq/docs-prose` so internal navigation stays client side.
 * The dashboard preview keeps the package default instead, because a preview
 * must not navigate the editor away.
 */
const RoutedLink: React.FC<ProseLinkProps> = ({
  href = "#",
  className,
  children,
}) => {
  // The class reaches the anchor itself. A card passes `no-underline!`: an
  // underline set on an anchor carries through to every line inside it, and
  // no class on those lines can take it off again.

  // TanStack Router gives hash-only links its default active state during
  // hydration. A plain anchor keeps the server and browser markup identical.
  if (href.startsWith("#")) {
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  }

  if (href.startsWith("/")) {
    return (
      <Link href={href} className={className}>
        {children}
      </Link>
    );
  }

  return (
    <a
      href={href}
      className={className}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
};

export default RoutedLink;
