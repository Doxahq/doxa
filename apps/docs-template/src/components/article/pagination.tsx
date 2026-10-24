import { useSiteConfig } from "@/src/site-config/site-config-context";
import { LuChevronLeft, LuChevronRight } from "react-icons/lu";

import { getSectionFromPath } from "@/src/settings/sections";
import { formatApiTitle } from "@/src/lib/api-reference";
import { getPageRoutesForSection } from "@/src/lib/pageroutes";
import { createDocsNearRoutePreload } from "@/src/lib/preload-policy";
import { Link } from "@/src/lib/transition";

interface PageLink {
  title: string;
  href: string;
  badge?: string;
}

function getPreviousNext(path: string) {
  const targetHref = `/${path.replace(/^\/+/, "")}`;
  const section = getSectionFromPath(targetHref);
  const pages = getPageRoutesForSection(section.slug);

  const index = pages.findIndex((route) => route.href === targetHref);
  if (index === -1) {
    return { prev: null, next: null };
  }

  const prev = index > 0 ? pages[index - 1] : null;
  const next = index < pages.length - 1 ? pages[index + 1] : null;

  return { prev, next };
}

export function Pagination({
  pathname,
  previous,
  next,
}: {
  pathname: string;
  previous?: PageLink | null;
  next?: PageLink | null;
}) {
  const docsNearRoutePreload = createDocsNearRoutePreload(
    useSiteConfig().features
  );
  const res =
    previous !== undefined || next !== undefined
      ? { prev: previous ?? null, next: next ?? null }
      : getPreviousNext(pathname);

  return (
    <div className="mt-12 flex items-center justify-between gap-4 border-t pt-6 pb-4">
      {res.prev ? (
        <Link
          rel="prev"
          href={res.prev.href}
          {...docsNearRoutePreload}
          title={`Previous: ${formatApiTitle(res.prev.title, res.prev.badge)}`}
          className="group flex flex-col items-start gap-1 no-underline!"
        >
          <span className="flex items-center text-xs text-muted-foreground">
            <LuChevronLeft className="mr-0.5 h-3 w-3" />
            Previous
          </span>
          <span className="text-sm font-medium text-foreground group-hover:text-primary">
            {formatApiTitle(res.prev.title, res.prev.badge)}
          </span>
        </Link>
      ) : (
        <div />
      )}
      {res.next && (
        <Link
          rel="next"
          href={res.next.href}
          {...docsNearRoutePreload}
          title={`Next: ${formatApiTitle(res.next.title, res.next.badge)}`}
          className="group ml-auto flex flex-col items-end gap-1 no-underline!"
        >
          <span className="flex items-center text-xs text-muted-foreground">
            Next
            <LuChevronRight className="ml-0.5 h-3 w-3" />
          </span>
          <span className="text-sm font-medium text-foreground group-hover:text-primary">
            {formatApiTitle(res.next.title, res.next.badge)}
          </span>
        </Link>
      )}
    </div>
  );
}
