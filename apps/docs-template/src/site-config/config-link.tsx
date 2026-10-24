import type { ComponentProps } from "react";

import { Link } from "@/src/lib/transition";

type ConfigLinkProps = Omit<ComponentProps<"a">, "href" | "target" | "rel"> & {
  href: string;
  newTab?: boolean;
};

/**
 * A link from the site config. An internal path navigates in the client, like
 * the sidebar. Any other href is a plain anchor. Site config rejects `//`, so
 * a leading `/` always means a path on this site.
 */
export function ConfigLink({ href, newTab = false, ...props }: ConfigLinkProps) {
  const target = newTab ? "_blank" : undefined;
  if (href.startsWith("/")) {
    return <Link {...props} href={href} target={target} />;
  }
  return (
    <a {...props} href={href} target={target} rel="noopener noreferrer" />
  );
}
