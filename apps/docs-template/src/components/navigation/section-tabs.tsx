import type { RuntimeSection } from "@/src/runtime";
import { useSiteConfig } from "@/src/site-config/site-config-context";
import { docsLayout } from "@doxahq/site-config";
import { useLocation } from "@tanstack/react-router";

import {
  getSectionFromPath,
  nonDefaultSections,
  visibleSections,
} from "@/src/settings/sections";
import { getPageRoutesForSection } from "@/src/lib/pageroutes";
import { createDocsNearRoutePreload } from "@/src/lib/preload-policy";
import { Link } from "@/src/lib/transition";
import { cn } from "@/src/lib/utils";

interface SectionTabsProps {
  sections?: RuntimeSection[];
  currentSectionSlug?: string | null;
  sectionHomeHrefs?: Record<string, string>;
  /**
   * `bar`: the sticky tab bar under the top bar. `navbar`: the tabs inside
   * the top bar, for the `in-navbar` placement (see `docsLayout`).
   */
  variant?: "bar" | "navbar";
}

// Hide entirely on single-section sites — keeps the existing UI unchanged.
// The docs layout calls this too, so it can size the sticky offsets that the
// sidebar and the table of contents depend on. Keep it the only place that
// decides whether the tab bar occupies vertical space.
export function hasSectionTabs(sections?: RuntimeSection[]): boolean {
  const runtimeSections = sections?.filter((section) => !section.hidden);
  return runtimeSections
    ? runtimeSections.some((section) => !section.default)
    : nonDefaultSections.length > 0;
}

export function SectionTabs({
  sections,
  currentSectionSlug,
  sectionHomeHrefs,
  variant = "bar",
}: SectionTabsProps = {}) {
  const config = useSiteConfig();
  const docsNearRoutePreload = createDocsNearRoutePreload(config.features);
  const layout = docsLayout(config);
  // "Page edge" centers the tabs over the article, which is centered too.
  const centered = layout.sidebar === "page-edge";
  const location = useLocation();
  const runtimeSections = sections?.filter((section) => !section.hidden);

  if (!hasSectionTabs(sections)) {
    return null;
  }

  const currentSlug =
    currentSectionSlug ?? getSectionFromPath(location.pathname).slug;
  const tabSections = runtimeSections ?? visibleSections;
  const inNavbar = variant === "navbar";

  const tabs = tabSections.map((section) => {
    const href =
      sectionHomeHrefs?.[section.slug] ??
      getPageRoutesForSection(section.slug)[0]?.href ??
      "/";
    const active = currentSlug === section.slug;
    return (
      <Link
        key={section.slug}
        href={href}
        {...docsNearRoutePreload}
        role="tab"
        aria-selected={active}
        className={cn(
          "relative flex h-full shrink-0 items-center px-1 whitespace-nowrap transition-colors",
          inNavbar
            ? // The mark sits on the top bar's bottom border.
              "text-sm after:absolute after:inset-x-0 after:-bottom-px after:h-0.5"
            : "-mb-px border-b-2 text-[13px] sm:text-sm",
          active
            ? cn(
                "font-semibold text-primary",
                inNavbar ? "after:bg-primary" : "border-primary"
              )
            : cn(
                "text-muted-foreground hover:text-foreground",
                !inNavbar && "border-transparent"
              )
        )}
      >
        {centered ? (
          // The bold label of the active tab is wider. Each tab keeps the bold
          // width, so the centered row does not shift when the section
          // changes.
          <span className="grid">
            <span className="col-start-1 row-start-1">{section.label}</span>
            <span
              aria-hidden="true"
              className="invisible col-start-1 row-start-1 font-semibold"
            >
              {section.label}
            </span>
          </span>
        ) : (
          section.label
        )}
      </Link>
    );
  });

  if (inNavbar) {
    return (
      <div
        className="flex h-full items-center gap-6"
        role="tablist"
        aria-label="Documentation sections"
      >
        {tabs}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "sticky top-(--docs-navbar-h) z-30 -mx-4 h-(--docs-tabs-h) [scrollbar-width:none] overflow-x-auto overflow-y-hidden border-b bg-background sm:-mx-6 md:-mx-8 [&::-webkit-scrollbar]:hidden",
        // With the tabs in the top bar, this bar shows only where the top bar
        // has no room for them.
        layout.sectionTabs === "in-navbar" && "lg:hidden"
      )}
      role="tablist"
      aria-label="Documentation sections"
    >
      <div
        className={cn(
          "flex h-full w-max items-center gap-4 px-4 sm:gap-6 sm:px-6 md:px-8",
          // Auto margins center a short row. A row wider than the bar still
          // scrolls from its start.
          centered && "mx-auto"
        )}
      >
        {tabs}
      </div>
    </div>
  );
}
