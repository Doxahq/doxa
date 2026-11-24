import { useSiteConfig } from "@/src/site-config/site-config-context";
import { LuChevronLeft, LuChevronRight } from "react-icons/lu";

import { getSectionFromPath } from "@/src/settings/sections";
import { formatApiTitle } from "@/src/lib/api-reference";
import { getPageRoutesForSection } from "@/src/lib/pageroutes";
import {
  createDocsNearRoutePreload,
  type DocsLinkPreloadPolicy,
} from "@/src/lib/preload-policy";
import { Link } from "@/src/lib/transition";
import { cn } from "@/src/lib/utils";

interface PageLink {
  title: string;
  href: string;
  badge?: string;
}

type PageDirection = "previous" | "next";

const DIRECTIONS = {
  previous: { label: "Previous", rel: "prev" },
  next: { label: "Next", rel: "next" },
} as const satisfies Record<PageDirection, { label: string; rel: string }>;

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

/**
 * Two cards to the previous and the next page. The next card always takes the
 * right column, so it does not move when there is no previous page.
 */
export function Pagination({
  pathname,
  previous,
  next,
}: {
  pathname: string;
  previous?: PageLink | null;
  next?: PageLink | null;
}) {
  const preload = createDocsNearRoutePreload(useSiteConfig().features);
  const pages =
    previous !== undefined || next !== undefined
      ? { prev: previous ?? null, next: next ?? null }
      : getPreviousNext(pathname);
  if (!pages.prev && !pages.next) return null;

  return (
    <nav
      aria-label="Previous and next page"
      className="not-prose mt-12 grid grid-cols-2 gap-4"
    >
      {pages.prev && (
        <PageLinkCard
          direction="previous"
          page={pages.prev}
          preload={preload}
        />
      )}
      {pages.next && (
        <PageLinkCard direction="next" page={pages.next} preload={preload} />
      )}
    </nav>
  );
}

function PageLinkCard({
  direction,
  page,
  preload,
}: {
  direction: PageDirection;
  page: PageLink;
  preload: DocsLinkPreloadPolicy;
}) {
  const { label, rel } = DIRECTIONS[direction];
  const title = formatApiTitle(page.title, page.badge);
  const isNext = direction === "next";

  return (
    <Link
      rel={rel}
      href={page.href}
      {...preload}
      title={`${label}: ${title}`}
      className={cn(
        "group flex min-w-0 flex-col gap-1.5 rounded-lg border px-4 py-3.5 transition-colors hover:border-primary",
        isNext && "col-start-2 items-end text-right"
      )}
    >
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        {!isNext && <LuChevronLeft className="size-3.5" aria-hidden="true" />}
        {label}
        {isNext && <LuChevronRight className="size-3.5" aria-hidden="true" />}
      </span>
      <span className="text-[15px] font-semibold text-foreground transition-colors group-hover:text-primary">
        {title}
      </span>
    </Link>
  );
}
