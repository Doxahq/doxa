import { useEffect, useId } from "react";
import type { RuntimeNavNode, RuntimeNavPage } from "@/src/runtime";
import { useSiteConfig } from "@/src/site-config/site-config-context";
import { docsLayout } from "@doxahq/site-config";
import { useLocation } from "@tanstack/react-router";
import { LuChevronDown, LuChevronRight } from "react-icons/lu";

import { Routes, type Paths } from "@/src/lib/pageroutes";
import { groupMenu, useCollapsedGroup } from "@/src/lib/sidebar-groups";
import { cn } from "@/src/lib/utils";
import SubLink, { type SubLinkRoute } from "@/src/components/sidebar/sublink";

type MenuRoute = Paths | RuntimeNavNode;

interface PageMenuProps {
  isSheet?: boolean;
  routes?: MenuRoute[];
  variant?: "docs" | "reference";
}

export function PageMenu({
  isSheet = false,
  routes,
  variant = "docs",
}: PageMenuProps) {
  const list = routes ?? Routes;
  const isReference = variant === "reference";
  const { collapsibleGroups } = docsLayout(useSiteConfig());

  if (collapsibleGroups) {
    return (
      <div
        className={`flex flex-col pb-6 ${isReference ? "gap-0.5" : "gap-1"}`}
      >
        {groupMenu(list, isMenuHeading, isMenuPage).map((block) => {
          if (block.type === "group") {
            return (
              <CollapsibleGroup
                key={`group-${block.heading}-${block.index}`}
                heading={block.heading}
                pages={block.pages}
                isReference={isReference}
                isSheet={isSheet}
              />
            );
          }
          const { item, index } = block;
          if ("spacer" in item) {
            return (
              <div
                key={`spacer-${index}`}
                className={`${index === 0 ? "" : "mt-4 mb-2 border-t border-foreground/10 dark:border-foreground/[0.06]"}`}
              />
            );
          }
          return isMenuPage(item) ? (
            <SubLink key={item.href} {...item} isSheet={isSheet} />
          ) : null;
        })}
      </div>
    );
  }

  return (
    <div className={`flex flex-col pb-6 ${isReference ? "gap-0.5" : "gap-1"}`}>
      {list.map((item, index) => {
        if ("spacer" in item) {
          return (
            <div
              key={`spacer-${index}`}
              className={`${index === 0 ? "" : "mt-4 mb-2 border-t border-foreground/10 dark:border-foreground/[0.06]"}`}
            />
          );
        }
        if (isMenuHeading(item)) {
          return (
            <div
              key={`heading-${item.heading}-${index}`}
              className={`${isReference ? "mt-3 mb-1" : "mt-2 mb-2"} px-2 text-[0.7rem] font-semibold text-foreground/50 dark:text-foreground/45`}
            >
              {item.heading}
            </div>
          );
        }
        if (isMenuPage(item)) {
          return (
            <SubLink
              key={item.href}
              {...{
                ...item,
                href: item.href,
                isSheet,
              }}
            />
          );
        }
        return null;
      })}
    </div>
  );
}

/**
 * A group heading that collapses and expands its pages. Groups start
 * expanded. The heading is larger than a plain one, and a chevron shows the
 * action: always when collapsed, on hover or focus when expanded.
 */
function CollapsibleGroup({
  heading,
  pages,
  isReference,
  isSheet,
}: {
  heading: string;
  pages: (RuntimeNavPage & SubLinkRoute)[];
  isReference: boolean;
  isSheet: boolean;
}) {
  const [collapsed, setCollapsed] = useCollapsedGroup(
    `${heading}\u0000${pages[0]?.href ?? ""}`
  );
  const pagesId = useId();
  const pathname = useLocation().pathname;
  const containsCurrent = pages.some((page) => page.href === pathname);

  // Opening a page inside a collapsed group shows its link.
  useEffect(() => {
    if (containsCurrent) setCollapsed(false);
  }, [containsCurrent, pathname, setCollapsed]);

  const Chevron = collapsed ? LuChevronRight : LuChevronDown;
  return (
    <div className={isReference ? "mt-3" : "mt-2"}>
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls={pagesId}
        onClick={() => setCollapsed(!collapsed)}
        className="group/heading flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm font-semibold text-foreground/80 transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 truncate">{heading}</span>
        <Chevron
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-opacity",
            !collapsed &&
              "opacity-0 group-hover/heading:opacity-100 group-focus-visible/heading:opacity-100"
          )}
        />
      </button>
      <div
        id={pagesId}
        inert={collapsed}
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            className={`flex flex-col pt-2 ${isReference ? "gap-0.5" : "gap-1"}`}
          >
            {pages.map((page) => (
              <SubLink key={page.href} {...page} isSheet={isSheet} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function isMenuHeading(
  item: MenuRoute
): item is Extract<MenuRoute, { heading: string }> {
  return "heading" in item && !("title" in item);
}

function isMenuPage(item: MenuRoute): item is RuntimeNavPage & SubLinkRoute {
  return "title" in item && "href" in item;
}
